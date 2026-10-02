import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { CodexAppServerClient, defaultServerRequestResponse, type JsonRpcMessage } from "./app-server-client.ts";
import {
  bridgeAgentApprovalPolicy,
  bridgeAgentDefaultSandbox,
  assertHardenedBossAgentConfig,
  assertHardenedBossBridgeConfig,
  loadBridgeConfig,
  loadBridgeState,
  saveBridgeState,
  type BridgeAgentConfig,
  type BridgeConfig,
  type BridgeState,
} from "./bridge-config.ts";
import { IntercomClient } from "../broker/client.ts";
import { assertBossCanonicalData } from "../broker/boss-adapter.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import { DEFAULT_ASK_TIMEOUT_MS, loadConfig, validateAskTimeoutMs } from "../config.ts";
import { assertHardenedBossProviderAuthority, type HardenedBossClientKind } from "./boss-client.ts";
import type { Message, SessionInfo } from "../types.ts";
import { resolveContactTarget, type IntercomContact } from "./contact.ts";
import { formatAttachments, formatSessionDisplay, formatSessionList, resolveSessionTarget, type ToolResult } from "./runtime.ts";
import { formatIntercomTeam, resolveIntercomTeam } from "./team.ts";
import { appendNamedTeamMembership, sessionNamedTeams, namedTeamRoster, formatNamedTeamRoster, resolveNamedMessageTeam } from "./named-team-membership.ts";
import { formatJoinableNamedTeamList, listNamedTeams } from "./named-teams.ts";
import { TASK_TEAM_GUIDANCE } from "./team-guidance.ts";

interface TurnWaiter {
  from: SessionInfo;
  message: Message;
}

interface ToolReplyWaiter {
  from: string;
  team?: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  cleanup?: () => void;
}

export interface ExternalTurnEvent {
  agentId: string;
  threadId: string;
  from: SessionInfo;
  message: Message;
  response: string;
}

export interface CodexBridgeHooks {
  onExternalTurnComplete?: (event: ExternalTurnEvent) => void;
}

export interface VirtualCodexAgentOptions {
  client?: IntercomClient;
  prepareConnection?: () => Promise<void>;
  reconnectDelays?: number[];
}

const APPROVED_INTERCOM_TOOLS = new Set([
  "intercom_whoami",
  "intercom_team",
  "intercom_join",
  "intercom_status",
  "intercom_list",
  "intercom_set_summary",
  "intercom_send",
  "intercom_ask",
  "intercom_pending",
  "intercom_reply",
]);
const MAX_TOOL_MESSAGES_PER_TURN = 8;
const MAX_TOOL_MESSAGES_PER_MINUTE = 30;

function formatMessage(from: SessionInfo, message: Message, agent: BridgeAgentConfig): string {
  const replyInstruction = message.expectsReply
    ? [
      "",
      "",
      "The sender is waiting for a blocking intercom reply.",
      "The coi sidecar will automatically send your final assistant message as the reply to this ask.",
      "Do not use intercom_reply or intercom_send to answer this ask; normal Codex MCP intercom tools run under a separate session identity and will not unblock the sender.",
      "If you need to acknowledge first, put the acknowledgement at the start of your final assistant message.",
    ].join("\n")
    : "";
  const attachments = message.content.attachments?.map((attachment) => {
    const language = attachment.language ? ` (${attachment.language})` : "";
    return `\n\nAttachment: ${attachment.name}${language}\n${attachment.content}`;
  }).join("") ?? "";
  const custom = agent.instructions ? `\n\nAgent instructions:\n${agent.instructions}` : "";
  return [
    `Intercom message for ${agent.name}.`,
    `From: ${formatSessionDisplay(from)} (${from.id})`,
    ...(message.content.team ? [`[Team: ${message.content.team}]`] : []),
    `Message id: ${message.id}`,
    "",
    message.content.text,
    attachments,
    custom,
    replyInstruction,
  ].join("\n");
}

function textInput(text: string) {
  return { type: "text", text, text_elements: [] };
}

function statusText(status: unknown): string {
  if (!status || typeof status !== "object" || !("type" in status)) return "unknown";
  const type = (status as { type?: unknown }).type;
  return typeof type === "string" ? type : "unknown";
}

function getThreadId(result: unknown): string {
  const thread = result && typeof result === "object" ? (result as Record<string, unknown>).thread : undefined;
  if (!thread || typeof thread !== "object" || typeof (thread as Record<string, unknown>).id !== "string") {
    throw new Error("Codex app-server response did not include thread.id");
  }
  return (thread as Record<string, string>).id;
}

export function threadSandboxMode(sandboxPolicy: unknown): string {
  if (!sandboxPolicy || typeof sandboxPolicy !== "object" || Array.isArray(sandboxPolicy)) return "read-only";
  const type = (sandboxPolicy as Record<string, unknown>).type;
  switch (type) {
    case "readOnly":
    case "read-only":
      return "read-only";
    case "workspaceWrite":
    case "workspace-write":
      return "workspace-write";
    case "dangerFullAccess":
    case "danger-full-access":
      return "danger-full-access";
    default:
      return "read-only";
  }
}

function protectedBossClientForBridge(config: BridgeConfig): HardenedBossClientKind | undefined {
  // Reject accessors/proxies before reading a deny-only launch marker.
  assertBossCanonicalData(config, "$.bridgeConfig");
  if (!Array.isArray(config.agents)) return undefined;
  for (const agent of config.agents) {
    if (typeof agent !== "object" || agent === null || Array.isArray(agent)) continue;
    if (agent.bossClient === "boss_participant" || agent.bossClient === "boss_reviewer") return agent.bossClient;
  }
  return undefined;
}

function bridgeAgentSandboxMode(agent: BridgeAgentConfig): string {
  return agent.sandboxPolicy === undefined
    ? bridgeAgentDefaultSandbox(agent) ?? "read-only"
    : threadSandboxMode(agent.sandboxPolicy);
}

function bridgeAgentTurnSandboxPolicy(agent: BridgeAgentConfig): unknown {
  if (agent.sandboxPolicy !== undefined) return agent.sandboxPolicy;
  if (bridgeAgentSandboxMode(agent) === "workspace-write") {
    throw new Error("workspace-write requires unavailable broker-owned assigned workspace authority");
  }
  return { type: "readOnly", networkAccess: false };
}

function getTurnId(result: unknown): string {
  const turn = result && typeof result === "object" ? (result as Record<string, unknown>).turn : undefined;
  if (!turn || typeof turn !== "object" || typeof (turn as Record<string, unknown>).id !== "string") {
    throw new Error("Codex app-server response did not include turn.id");
  }
  return (turn as Record<string, string>).id;
}

function getNotificationThreadId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = (params as Record<string, unknown>).threadId;
  return typeof value === "string" ? value : null;
}

function getNotificationTurnId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const direct = (params as Record<string, unknown>).turnId;
  if (typeof direct === "string") return direct;
  const turn = (params as Record<string, unknown>).turn;
  if (turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string") {
    return (turn as Record<string, string>).id;
  }
  return null;
}

function getCompletedAgentText(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const item = (params as Record<string, unknown>).item;
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  return raw.type === "agentMessage" && typeof raw.text === "string" ? raw.text : null;
}

function intercomSendFromArgs(rawArgs: unknown): { to: string; message: string; team?: string } | null {
  let args: Record<string, unknown>;
  try {
    args = parseToolArguments(rawArgs);
  } catch {
    return null;
  }
  return typeof args.to === "string" && typeof args.message === "string"
    ? { to: args.to, message: args.message, ...(typeof args.team === "string" ? { team: args.team } : {}) }
    : null;
}

export function getCompletedIntercomSend(params: unknown): { to: string; message: string; team?: string } | null {
  if (!params || typeof params !== "object") return null;
  const item = (params as Record<string, unknown>).item;
  if (!isRecord(item)) return null;
  const rawName = item.name ?? item.toolName ?? item.tool_name;
  if (typeof rawName !== "string" || normalizeToolName(rawName) !== "intercom_send") return null;
  return intercomSendFromArgs(item.arguments ?? item.args ?? item.input);
}

export function getApprovedIntercomSend(params: unknown): { to: string; message: string; team?: string } | null {
  if (getApprovedIntercomToolFromApproval(params) !== "intercom_send") return null;
  if (!isRecord(params)) return null;
  const meta = isRecord(params._meta) ? params._meta : {};
  return intercomSendFromArgs(meta.tool_params ?? meta.toolParams ?? meta.tool_params_json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function asOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return validateAskTimeoutMs(value, name);
}

function normalizeToolName(name: string): string {
  const mcpMatch = name.match(/(?:^|__|\.)intercom_(whoami|team|join|status|list|set_summary|send|ask|pending|reply)$/);
  if (mcpMatch) return `intercom_${mcpMatch[1]}`;
  return name;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") {
    const parsed: unknown = value.trim() ? JSON.parse(value) : {};
    if (!isRecord(parsed)) throw new Error("tool arguments must be an object");
    return parsed;
  }
  if (!isRecord(value)) throw new Error("tool arguments must be an object");
  return value;
}

function extractToolCall(message: JsonRpcMessage): { threadId: string | null; turnId: string | null; name: string; args: Record<string, unknown> } {
  const params = isRecord(message.params) ? message.params : {};
  const nested = ["toolCall", "tool", "call", "item"]
    .map((key) => params[key])
    .find(isRecord) ?? {};
  const rawName = params.name ?? params.toolName ?? params.tool_name ?? nested.name ?? nested.toolName ?? nested.tool_name;
  if (typeof rawName !== "string") throw new Error("item/tool/call did not include a tool name");
  const rawArgs = params.arguments ?? params.args ?? params.input ?? nested.arguments ?? nested.args ?? nested.input;
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  const turnId = typeof params.turnId === "string" ? params.turnId : null;
  return { threadId, turnId, name: normalizeToolName(rawName), args: parseToolArguments(rawArgs) };
}

function textToolResult(text: string, structuredContent?: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function appServerToolResponse(result: ToolResult): unknown {
  return {
    success: !result.isError,
    contentItems: result.content,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}

export class VirtualCodexAgent {
  private client: IntercomClient;
  private threadId: string | null;
  private activeTurnId: string | null = null;
  private waiters = new Map<string, TurnWaiter[]>();
  private finalMessages = new Map<string, string>();
  private toolReplyWaiters = new Map<string, ToolReplyWaiter>();
  private messageQueue: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private turnCompletionWaiters = new Map<string, Array<() => void>>();
  private toolMessageCountsByTurn = new Map<string, number>();
  private toolMessageTimestamps: number[] = [];
  private externalTurns = new Map<string, { from: SessionInfo; message: Message }>();
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnectEnabled = true;
  private readonly intercomStartedAt = Date.now();
  private readonly prepareConnection: () => Promise<void>;
  private readonly reconnectDelays: number[];
  private readonly scopeId: string | undefined;

  constructor(
    private readonly agent: BridgeAgentConfig,
    private readonly app: CodexAppServerClient,
    private readonly state: BridgeState,
    private readonly statePath: string,
    private readonly hooks: CodexBridgeHooks = {},
    options: VirtualCodexAgentOptions = {},
    scopeId?: string,
  ) {
    this.threadId = agent.threadId ?? state.agents[agent.id]?.threadId ?? null;
    this.scopeId = scopeId;
    this.client = options.client ?? new IntercomClient(scopeId ? { scopeId } : {});
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.reconnectDelays = options.reconnectDelays?.length ? options.reconnectDelays : [250, 500, 1000, 2000, 5000];
  }

  async start(): Promise<void> {
    this.reconnectEnabled = true;
    this.client.on("message", (from: SessionInfo, message: Message, deliveryId: string) => {
      const routed = this.routeMessage(from, message);
      this.client.acknowledgeMessage(deliveryId);
      void routed.catch((error) => {
        this.client.updatePresence({ status: `error: ${error instanceof Error ? error.message : String(error)}` });
      });
    });
    this.client.on("error", (error) => {
      process.stderr.write(`intercom ${this.agent.id}: ${error.message}\n`);
    });
    this.client.on("disconnected", (error: Error) => {
      this.rejectAllToolReplies(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      this.scheduleReconnect();
    });
    await this.connectIntercom();
  }

  private async connectIntercom(): Promise<void> {
    this.clearReconnectTimer();
    if (this.client.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      await this.prepareConnection();
      await this.client.connect({
        name: this.agent.name,
        cwd: this.agent.cwd,
        model: this.agent.model ?? "codex-app-server",
        pid: process.pid,
        startedAt: this.intercomStartedAt,
        lastActivity: Date.now(),
        status: this.threadId ? "idle" : "idle:no-thread",
      }, this.agent.id);
      this.reconnectAttempt = 0;
    })();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)]!;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectIntercom().then(() => {
        if (!this.client.isConnected()) {
          this.reconnectAttempt += 1;
          this.scheduleReconnect();
        }
      }).catch((error) => {
        this.reconnectAttempt += 1;
        process.stderr.write(`intercom ${this.agent.id}: reconnect failed: ${error instanceof Error ? error.message : String(error)}\n`);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private rejectAllToolReplies(error: Error): void {
    for (const [replyTo, waiter] of Array.from(this.toolReplyWaiters.entries())) {
      clearTimeout(waiter.timeout);
      waiter.cleanup?.();
      this.toolReplyWaiters.delete(replyTo);
      waiter.reject(error);
    }
  }

  async stop(): Promise<void> {
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // A failed in-progress connection is already closed.
      }
    }
    await this.client.disconnect();
  }

  get id(): string {
    return this.agent.id;
  }

  async getContactTarget(): Promise<IntercomContact> {
    return resolveContactTarget(this.agent.id, this.agent.name, () => this.client.listSessions());
  }

  ownsThread(threadId: string): boolean {
    return this.threadId === threadId;
  }

  onNotification(message: JsonRpcMessage): void {
    const threadId = getNotificationThreadId(message.params);
    if (!threadId || threadId !== this.threadId) return;

    if (message.method === "thread/name/updated" && isRecord(message.params)) {
      const name = message.params.threadName;
      if (typeof name === "string" && name.trim() && name !== this.agent.name) {
        this.agent.name = name;
        this.client.updatePresence({ name });
      }
      return;
    }

    if (message.method === "error") {
      const params = isRecord(message.params) ? message.params : {};
      const detail = isRecord(params.error) && typeof params.error.message === "string"
        ? params.error.message
        : "Codex turn error";
      const willRetry = params.willRetry === true;
      this.client.updatePresence({ status: willRetry ? `reconnecting: ${detail}` : `error: ${detail}` });
      process.stderr.write(`codex ${this.agent.id}: ${detail}${willRetry ? "; app-server is retrying" : ""}\n`);
      return;
    }

    if (message.method === "turn/started") {
      this.activeTurnId = getNotificationTurnId(message.params);
      this.client.updatePresence({ status: "active" });
      return;
    }

    if (message.method === "thread/status/changed" && message.params && typeof message.params === "object") {
      const status = statusText((message.params as Record<string, unknown>).status);
      this.client.updatePresence({ status });
      return;
    }

    if (message.method === "item/completed") {
      const turnId = getNotificationTurnId(message.params);
      const text = getCompletedAgentText(message.params);
      if (turnId && text) this.finalMessages.set(turnId, text);
      const intercomSend = getCompletedIntercomSend(message.params);
      if (turnId && intercomSend) {
        void this.replyToWaitersFromIntercomSend(turnId, intercomSend).catch((error) => {
          process.stderr.write(`reply failed for ${this.agent.id} after intercom_send: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
      return;
    }

    if (message.method === "turn/completed") {
      const turnId = getNotificationTurnId(message.params);
      if (!turnId) return;
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      this.client.updatePresence({ status: "idle" });
      const idleWaiters = this.idleWaiters.splice(0);
      for (const resolve of idleWaiters) resolve();
      void this.finishTurn(turnId);
    }
  }

  async ensureThread(): Promise<string> {
    if (this.threadId) {
      try {
        const sandbox = bridgeAgentSandboxMode(this.agent);
        const result = await this.app.request("thread/resume", {
          threadId: this.threadId,
          cwd: this.agent.cwd,
          model: this.agent.model ?? null,
          approvalPolicy: bridgeAgentApprovalPolicy(this.agent),
          sandbox,
        });
        if (isRecord(result) && isRecord(result.thread)) {
          this.onNotification({ method: "thread/name/updated", params: {
            threadId: this.threadId, threadName: result.thread.name,
          } });
        }
        return this.threadId;
      } catch {
        this.threadId = null;
      }
    }

    const sandbox = bridgeAgentSandboxMode(this.agent);
    const result = await this.app.request("thread/start", {
      cwd: this.agent.cwd,
      model: this.agent.model ?? null,
      approvalPolicy: bridgeAgentApprovalPolicy(this.agent),
      sandbox,
      serviceName: "codex-intercom",
      developerInstructions: [this.agent.instructions, TASK_TEAM_GUIDANCE].filter(Boolean).join("\n\n"),
      threadSource: "cli",
    });
    this.threadId = getThreadId(result);
    this.state.agents[this.agent.id] = { threadId: this.threadId, updatedAt: Date.now() };
    saveBridgeState(this.statePath, this.state);
    await this.app.request("thread/name/set", { threadId: this.threadId, name: this.agent.name }).catch(() => undefined);
    this.client.updatePresence({ status: "idle" });
    return this.threadId;
  }

  private routeMessage(from: SessionInfo, message: Message): Promise<void> {
    const toolWaiter = this.toolReplyWaiters.get(message.replyTo ?? "");
    if (toolWaiter) {
      if (from.id === toolWaiter.from && message.content.team === toolWaiter.team) {
        this.toolReplyWaiters.delete(message.replyTo ?? "");
        clearTimeout(toolWaiter.timeout);
        toolWaiter.cleanup?.();
        toolWaiter.resolve(message);
        return Promise.resolve();
      }
    }

    const run = this.messageQueue
      .catch(() => undefined)
      .then(() => this.handleMessage(from, message));
    this.messageQueue = run.catch((error) => {
      this.client.updatePresence({ status: `error: ${error instanceof Error ? error.message : String(error)}` });
    });
    return run;
  }

  private async handleMessage(from: SessionInfo, message: Message): Promise<void> {
    const threadId = await this.ensureThread();
    await this.waitUntilIdle();
    const input = [textInput(formatMessage(from, message, this.agent))];
    const result = await this.startTurn(threadId, input);
    const turnId = getTurnId(result);
    this.externalTurns.set(turnId, { from, message });
    const completed = this.waitForTurnCompletion(turnId);

    if (message.expectsReply) {
      const waiters = this.waiters.get(turnId) ?? [];
      waiters.push({ from, message });
      this.waiters.set(turnId, waiters);
    }
    await completed;
  }

  private startTurn(threadId: string, input: Array<ReturnType<typeof textInput>>): Promise<unknown> {
    this.client.updatePresence({ status: "active" });
    return this.app.request("turn/start", {
      threadId,
      input,
      cwd: this.agent.cwd,
      approvalPolicy: bridgeAgentApprovalPolicy(this.agent),
      sandboxPolicy: bridgeAgentTurnSandboxPolicy(this.agent),
      model: this.agent.model ?? null,
    });
  }

  private async replyToWaiters(turnId: string): Promise<void> {
    const waiters = this.waiters.get(turnId);
    if (!waiters?.length) return;
    this.waiters.delete(turnId);
    const reply = this.finalMessages.get(turnId)?.trim() || "Codex turn completed without a final message.";
    for (const waiter of waiters) {
      await this.client.send(waiter.from.id, { text: reply, replyTo: waiter.message.id, team: waiter.message.content.team }).catch((error) => {
        process.stderr.write(`reply failed for ${this.agent.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
  }

  async replyToWaitersFromIntercomSend(turnId: string, send: { to: string; message: string; team?: string }): Promise<void> {
    const waiters = this.waiters.get(turnId);
    if (!waiters?.length) return;
    const lowerTo = send.to.toLowerCase();
    const remaining: TurnWaiter[] = [];
    for (const waiter of waiters) {
      if (send.team !== undefined && send.team !== waiter.message.content.team) {
        remaining.push(waiter);
        continue;
      }
      const matchesSender = send.to === waiter.from.id
        || waiter.from.id.startsWith(send.to)
        || waiter.from.name?.toLowerCase() === lowerTo;
      if (!matchesSender) {
        remaining.push(waiter);
        continue;
      }
      await this.client.send(waiter.from.id, { text: send.message, replyTo: waiter.message.id, team: waiter.message.content.team }).catch((error) => {
        remaining.push(waiter);
        process.stderr.write(`reply failed for ${this.agent.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
    if (remaining.length) {
      this.waiters.set(turnId, remaining);
    } else {
      this.waiters.delete(turnId);
    }
  }

  private waitUntilIdle(): Promise<void> {
    if (!this.activeTurnId) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private waitForTurnCompletion(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.turnCompletionWaiters.get(turnId) ?? [];
      waiters.push(resolve);
      this.turnCompletionWaiters.set(turnId, waiters);
    });
  }

  private async finishTurn(turnId: string): Promise<void> {
    try {
      await this.replyToWaiters(turnId);
      const external = this.externalTurns.get(turnId);
      if (external && this.threadId) {
        this.hooks.onExternalTurnComplete?.({
          agentId: this.agent.id,
          threadId: this.threadId,
          from: external.from,
          message: external.message,
          response: this.finalMessages.get(turnId)?.trim() || "Codex turn completed without a final message.",
        });
      }
    } finally {
      this.externalTurns.delete(turnId);
      this.finalMessages.delete(turnId);
      this.waiters.delete(turnId);
      this.toolMessageCountsByTurn.delete(turnId);
      const waiters = this.turnCompletionWaiters.get(turnId) ?? [];
      this.turnCompletionWaiters.delete(turnId);
      for (const resolve of waiters) resolve();
    }
  }

  async handleToolCall(name: string, args: Record<string, unknown>, turnId: string | null, signal?: AbortSignal): Promise<unknown> {
    try {
      const result = await this.callIntercomTool(name, args, turnId, signal);
      return appServerToolResponse(result);
    } catch (error) {
      return appServerToolResponse(textToolResult(error instanceof Error ? error.message : String(error), { ok: false }, true));
    }
  }

  private async callIntercomTool(name: string, args: Record<string, unknown>, turnId: string | null, signal?: AbortSignal): Promise<ToolResult> {
    switch (name) {
      case "intercom_whoami":
        return textToolResult(
          `session_id: ${this.agent.id}\nname: ${this.agent.name}\ncwd: ${this.agent.cwd}`,
          { session_id: this.agent.id, name: this.agent.name, cwd: this.agent.cwd, model: this.agent.model ?? "codex-app-server" },
        );
      case "intercom_join": {
        if (args.name === undefined) {
          if (args.create || args.members !== undefined || args.work !== undefined) throw new Error("Creating or extending a team requires a name");
          return textToolResult(formatJoinableNamedTeamList(listNamedTeams()));
        }
        if (args.members !== undefined && !Array.isArray(args.members)) throw new Error("members must be an array");
        const sessions = await this.client.listSessions();
        const members = Array.from((args.members ?? []) as unknown[], (member) => {
          const id = resolveSessionTarget(sessions, asString(member, "member"));
          if (!id) throw new Error("Team member is not connected");
          return id;
        });
        const team = await appendNamedTeamMembership({ name: asString(args.name, "name"), selfId: this.agent.id, members, create: args.create === true, ...(args.work === undefined ? {} : { work: asString(args.work, "work") }) });
        const roster = namedTeamRoster(team, this.agent.id, sessions);
        return textToolResult(formatNamedTeamRoster(roster), { ok: true, team: team.name, roster });
      }
      case "intercom_team": {
        const sessions = await this.client.listSessions();
        const mine = sessionNamedTeams(this.agent.id);
        const requested = args.team === undefined ? undefined : asString(args.team, "team");
        const selected = requested ? mine.filter((entry) => entry.name === requested) : mine;
        if (requested && !selected.length) throw new Error("You do not belong to that team");
        if (selected.length) {
          const teams = selected.map((entry) => namedTeamRoster(entry, this.agent.id, sessions));
          return textToolResult(teams.map(formatNamedTeamRoster).join("\n\n"), { teams });
        }
        const team = await resolveIntercomTeam({ selfId: this.agent.id, sessions });
        return textToolResult(formatIntercomTeam(team), team as unknown as Record<string, unknown>);
      }
      case "intercom_status": {
        const sessions = await this.client.listSessions();
        return textToolResult(
          `Connected: Yes\nSession ID: ${this.agent.id}\nActive sessions: ${sessions.length}`,
          { connected: true, session_id: this.agent.id, active_sessions: sessions.length },
        );
      }
      case "intercom_list": {
        const includeSelf = typeof args.include_self === "boolean" ? args.include_self : false;
        const sessions = (await this.client.listSessions()).filter((session) => includeSelf || session.id !== this.agent.id);
        return textToolResult(formatSessionList(sessions, this.agent.id, this.agent.cwd), { sessions });
      }
      case "intercom_set_summary": {
        const summary = asString(args.summary, "summary");
        this.client.updatePresence({ status: summary.trim() || "idle" });
        return textToolResult("Summary updated.", { ok: true, summary });
      }
      case "intercom_send": {
        const limit = this.reserveToolMessage(turnId);
        if (limit) return limit;
        const to = asString(args.to, "to");
        const message = asString(args.message, "message");
        const sendTo = await this.resolveTarget(to);
        const team = resolveNamedMessageTeam(this.agent.id, sendTo, args.team === undefined ? undefined : asString(args.team, "team"));
        const result = await this.client.send(sendTo, { text: message, team });
        if (!result.delivered) {
          return textToolResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
        }
        return textToolResult(`Message sent to ${to}.`, { ok: true, message_id: result.id, to });
      }
      case "intercom_ask": {
        const limit = this.reserveToolMessage(turnId);
        if (limit) return limit;
        const to = asString(args.to, "to");
        const message = asString(args.message, "message");
        const timeoutMs = asOptionalPositiveInteger(args.timeout_ms, "timeout_ms") ?? DEFAULT_ASK_TIMEOUT_MS;
        const sendTo = await this.resolveTarget(to);
        const team = resolveNamedMessageTeam(this.agent.id, sendTo, args.team === undefined ? undefined : asString(args.team, "team"));
        const questionId = randomUUID();
        const replyPromise = this.waitForToolReply(sendTo, questionId, timeoutMs, signal, team);
        void replyPromise.catch(() => undefined);
        const result = await this.client.send(sendTo, { messageId: questionId, text: message, expectsReply: true, team });
        if (!result.delivered) {
          this.rejectToolReply(questionId, new Error(result.reason ?? "Session may not exist or has disconnected."));
          return textToolResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
        }
        const reply = await replyPromise;
        return textToolResult(`Reply from ${to}:\n${reply.content.text}${formatAttachments(reply.content.attachments)}`, { ok: true, message_id: result.id, reply });
      }
      case "intercom_pending":
        return textToolResult("No unread messages.", { unread_messages: [], pending_asks: [] });
      case "intercom_reply":
        return textToolResult("No matching pending ask. App-server sidecar asks are answered automatically by final assistant messages.", { ok: false }, true);
      default:
        return textToolResult(`Unknown tool: ${name}`, { ok: false }, true);
    }
  }

  private reserveToolMessage(turnId: string | null): ToolResult | null {
    const now = Date.now();
    this.toolMessageTimestamps = this.toolMessageTimestamps.filter((timestamp) => now - timestamp < 60000);
    if (this.toolMessageTimestamps.length >= MAX_TOOL_MESSAGES_PER_MINUTE) {
      return textToolResult(`Intercom message limit reached: max ${MAX_TOOL_MESSAGES_PER_MINUTE} sidecar-originated sends per minute.`, { ok: false, limit: "per_minute" }, true);
    }

    const key = turnId ?? "unknown-turn";
    const count = this.toolMessageCountsByTurn.get(key) ?? 0;
    if (count >= MAX_TOOL_MESSAGES_PER_TURN) {
      return textToolResult(`Intercom message limit reached: max ${MAX_TOOL_MESSAGES_PER_TURN} sidecar-originated sends per turn.`, { ok: false, limit: "per_turn" }, true);
    }

    this.toolMessageCountsByTurn.set(key, count + 1);
    this.toolMessageTimestamps.push(now);
    return null;
  }

  private async resolveTarget(to: string): Promise<string> {
    const sessions = await this.client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }

  private waitForToolReply(from: string, replyTo: string, timeoutMs = DEFAULT_ASK_TIMEOUT_MS, signal?: AbortSignal, team?: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("intercom_ask cancelled"));
        return;
      }
      let timeout: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.toolReplyWaiters.delete(replyTo);
        cleanup();
        void this.client.cancelAsk(replyTo);
        reject(new Error("intercom_ask cancelled"));
      };
      timeout = setTimeout(() => {
        this.toolReplyWaiters.delete(replyTo);
        void this.client.deferAsk(replyTo);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.toolReplyWaiters.set(replyTo, { from, team, resolve, reject, timeout, cleanup });
    });
  }

  private rejectToolReply(replyTo: string, error: Error): void {
    const waiter = this.toolReplyWaiters.get(replyTo);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    waiter.cleanup?.();
    this.toolReplyWaiters.delete(replyTo);
    waiter.reject(error);
    void this.client.cancelAsk(replyTo);
  }
}

export class CodexBridgeDaemon {
  private app: CodexAppServerClient;
  private agents: VirtualCodexAgent[] = [];
  private inflightToolCalls = new Map<string | number, AbortController>();

  constructor(private readonly config: BridgeConfig, private readonly hooks: CodexBridgeHooks = {}, private readonly scopeId?: string) {
    // A marker is deny-only here: no config field can provide executable or
    // artifact authority.
    const protectedBossClient = protectedBossClientForBridge(config);
    assertHardenedBossProviderAuthority(protectedBossClient);
    assertHardenedBossBridgeConfig(config);
    for (const agent of config.agents) assertHardenedBossAgentConfig(agent);
    this.app = new CodexAppServerClient(config.appServer, protectedBossClient);
    this.app.setServerRequestHandler((message) => this.handleServerRequest(message));
  }

  async start(): Promise<void> {
    // Revalidate immediately before CodexAppServerClient reaches either its
    // daemon spawnSync or stdio spawn boundary.
    assertHardenedBossProviderAuthority(protectedBossClientForBridge(this.config));
    assertHardenedBossBridgeConfig(this.config);
    for (const agent of this.config.agents) assertHardenedBossAgentConfig(agent);
    const intercomConfig = loadConfig();
    await spawnBrokerIfNeeded(intercomConfig.brokerCommand, intercomConfig.brokerArgs);
    await this.app.connect();
    const state = loadBridgeState(this.config.statePath);
    this.app.on("notification", (message: JsonRpcMessage) => {
      if (message.method === "notifications/cancelled" && message.params && typeof message.params === "object") {
        const requestId = (message.params as Record<string, unknown>).requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          this.inflightToolCalls.get(requestId)?.abort();
        }
      }
      for (const agent of this.agents) agent.onNotification(message);
    });
    this.agents = this.config.agents.map((agent) => new VirtualCodexAgent(agent, this.app, state, this.config.statePath, this.hooks, {}, this.scopeId));
    for (const agent of this.agents) await agent.start();
    process.stderr.write(`codex-intercom bridge running ${this.agents.length} virtual agent(s)\n`);
  }

  async stop(): Promise<void> {
    for (const agent of this.agents) await agent.stop().catch(() => undefined);
    await this.app.disconnect();
  }

  async ensureThreadForAgent(agentId: string): Promise<string> {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`No bridge agent registered with id: ${agentId}`);
    return agent.ensureThread();
  }

  async getContactTargetForAgent(agentId: string): Promise<IntercomContact> {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`No bridge agent registered with id: ${agentId}`);
    return agent.getContactTarget();
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<unknown> {
    if (message.method === "mcpServer/elicitation/request" && isIntercomToolApprovalRequest(message.params)) {
      const threadId = getNotificationThreadId(message.params);
      const turnId = getNotificationTurnId(message.params);
      const intercomSend = getApprovedIntercomSend(message.params);
      if (threadId && turnId && intercomSend) {
        const agent = this.agents.find((candidate) => candidate.ownsThread(threadId));
        if (agent) await agent.replyToWaitersFromIntercomSend(turnId, intercomSend);
      }
      return { action: "accept", content: {}, _meta: null };
    }

    if (message.method !== "item/tool/call") {
      if (!message.method) throw new Error("Unsupported app-server request");
      return defaultServerRequestResponse(message.method);
    }

    const call = extractToolCall(message);
    const agent = call.threadId
      ? this.agents.find((candidate) => candidate.ownsThread(call.threadId!))
      : this.agents[0];
    if (!agent) return appServerToolResponse(textToolResult("No bridge agent owns this tool call.", { ok: false }, true));
    const requestId = message.id;
    const abortController = typeof requestId === "string" || typeof requestId === "number"
      ? new AbortController()
      : null;
    if (abortController && requestId !== undefined) this.inflightToolCalls.set(requestId, abortController);
    try {
      return await agent.handleToolCall(call.name, call.args, call.turnId, abortController?.signal);
    } finally {
      if (abortController && requestId !== undefined) this.inflightToolCalls.delete(requestId);
    }
  }
}

export function isIntercomToolApprovalRequest(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const meta = isRecord(params._meta) ? params._meta : {};
  return params.serverName === "codex-intercom"
    && meta.codex_approval_kind === "mcp_tool_call"
    && Boolean(getApprovedIntercomToolFromApproval(params));
}

export function getApprovedIntercomToolFromApproval(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const meta = isRecord(params._meta) ? params._meta : {};
  const candidates = [
    meta.tool,
    meta.toolName,
    meta.tool_name,
    meta.name,
    typeof params.message === "string" ? params.message.match(/tool "([^"]+)"/)?.[1] : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && APPROVED_INTERCOM_TOOLS.has(candidate)) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : undefined;
  const config = loadBridgeConfig(configPath);
  if (!config.agents.length) throw new Error("Bridge config must include at least one agent");
  const daemon = new CodexBridgeDaemon(config);
  const stop = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await daemon.start();
  await once(process, "SIGTERM");
}

if (process.argv[1] && (basename(process.argv[1]) === "bridge-daemon.ts" || basename(process.argv[1]) === "bridge-daemon.mjs")) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
