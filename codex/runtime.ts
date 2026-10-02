import { randomUUID, createHash } from "crypto";
import { spawnSync } from "child_process";
import { basename } from "path";
import { cwd as processCwd } from "process";
import { IntercomClient } from "../broker/client.ts";
import { intercomScopeIdFromEnv } from "../protocol-v4/contract.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import { getAskTimeoutMs, loadConfig } from "../config.ts";
import type { Attachment, Message, SessionInfo } from "../types.ts";
import { formatIntercomTeam, resolveIntercomTeam } from "./team.ts";
import {
  formatCreateSuccess,
  formatJoinableNamedTeamList,
  formatNamedJoinSuccess,
  listNamedTeams,
  parseTeamName,
} from "./named-teams.ts";
import { appendNamedTeamMembership, sessionNamedTeams, namedTeamRoster, formatNamedTeamRoster, resolveNamedMessageTeam } from "./named-team-membership.ts";
import { contextId, askId, replyHint, selectReplyContext } from "./reply-context.ts";

export interface CodexRuntimeIdentity {
  sessionId: string;
  name: string;
  cwd: string;
  model: string;
  startedAt: number;
}

export interface PendingInboundMessage {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
  read: boolean;
}

export type ReplyWhich = "oldest" | "latest";

function matchesPendingSender(entry: PendingInboundMessage, to: string): boolean {
  return entry.from.id === to
    || entry.from.name?.toLowerCase() === to.toLowerCase()
    || entry.from.id.startsWith(to);
}

export function selectPendingAsk(entries: PendingInboundMessage[], to?: string, which?: ReplyWhich): PendingInboundMessage {
  const sorted = [...entries].sort((a, b) => a.receivedAt - b.receivedAt);
  if (sorted.length === 0) throw new Error("No matching pending ask. Call intercom_pending to inspect unresolved asks.");
  const matches = to ? sorted.filter((entry) => matchesPendingSender(entry, to)) : sorted;
  if (matches.length === 0) throw new Error(`No pending ask from "${to}".`);
  if (matches.length === 1) return matches[0]!;
  if (!to && new Set(matches.map((entry) => entry.from.id)).size > 1) {
    throw new Error("Multiple pending asks — specify `to` using a sender from intercom_pending.");
  }
  if (!which) {
    const sender = to ? ` from "${to}"` : "";
    throw new Error(`Multiple pending asks${sender} — specify \`which\` as \`oldest\` or \`latest\`.`);
  }
  return which === "oldest" ? matches[0]! : matches[matches.length - 1]!;
}

function pendingSelector(entries: PendingInboundMessage[], entry: PendingInboundMessage): "oldest" | "latest" | "queued" | undefined {
  const sameSender = entries.filter((candidate) => candidate.from.id === entry.from.id);
  if (sameSender.length <= 1) return undefined;
  const index = sameSender.findIndex((candidate) => candidate.message.id === entry.message.id);
  if (index === 0) return "oldest";
  if (index === sameSender.length - 1) return "latest";
  return "queued";
}

function publicPendingEntry(entry: PendingInboundMessage, selector?: string): Record<string, unknown> {
  return {
    from: {
      id: entry.from.id,
      name: entry.from.name,
      origin: entry.from.origin ?? "local",
      ...(entry.from.remoteHostId ? { remote_host_id: entry.from.remoteHostId } : {}),
      ...(entry.from.parentSessionId ? { parent_session_id: entry.from.parentSessionId } : {}),
      ...(entry.from.generation ? { generation: entry.from.generation } : {}),
    },
    contextId: contextId(entry),
    ...(entry.message.expectsReply ? { askId: askId(entry) } : {}),
    ...(entry.message.content.team ? { team: entry.message.content.team } : {}),
    received_at: entry.receivedAt,
    read: entry.read,
    text: entry.message.content.text,
    attachments: entry.message.content.attachments,
    expects_reply: entry.message.expectsReply,
    ...(selector ? { selector } : {}),
  };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ReplyWaiter {
  from: string;
  replyTo: string;
  team?: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  cleanup?: () => void;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

const GENERIC_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

export function buildCodexRuntimeIdentity(env: NodeJS.ProcessEnv = process.env, cwd = env.PWD || processCwd(), pid = process.pid): CodexRuntimeIdentity {
  let sessionId = env.CODEX_INTERCOM_SESSION_ID?.trim()
    || env.CODEX_PEER_ID?.trim();
  if (!sessionId && env.AGENT_INTERCOM_SESSION_ID !== undefined) {
    const raw = env.AGENT_INTERCOM_SESSION_ID.trim();
    if (raw) {
      if (!GENERIC_SESSION_ID_REGEX.test(raw)) {
        throw new Error("Invalid AGENT_INTERCOM_SESSION_ID: must match ^[A-Za-z0-9_-]{1,128}$");
      }
      sessionId = raw;
    }
  }
  if (!sessionId) {
    sessionId = `codex-${pid}-${shortHash(cwd)}`;
  }

  const cwdName = basename(cwd) || "workspace";
  const name = env.CODEX_INTERCOM_NAME?.trim()
    || env.CODEX_PEER_NAME?.trim()
    || (env.AGENT_INTERCOM_SESSION_NAME !== undefined && env.AGENT_INTERCOM_SESSION_NAME.trim() ? env.AGENT_INTERCOM_SESSION_NAME.trim() : undefined)
    || `codex-${cwdName}-${pid}`;
  return {
    sessionId,
    name,
    cwd,
    model: env.CODEX_INTERCOM_MODEL?.trim() || env.CODEX_MODEL?.trim() || "codex",
    startedAt: Date.now(),
  };
}

export function formatAttachments(attachments: Attachment[] | undefined): string {
  if (!attachments?.length) return "";
  return attachments.map((attachment) => {
    if (attachment.language) {
      return `\n\n---\nAttachment: ${attachment.name}\n~~~${attachment.language}\n${attachment.content}\n~~~`;
    }
    return `\n\n---\nAttachment: ${attachment.name}\n${attachment.content}`;
  }).join("");
}

export function resolveSessionTarget(sessions: SessionInfo[], nameOrId: string): string | null {
  const byId = sessions.find((session) => session.id === nameOrId);
  if (byId) return byId.id;

  const lowerName = nameOrId.toLowerCase();
  const byName = sessions.filter((session) => session.name?.toLowerCase() === lowerName);
  if (byName.length > 1) {
    throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
  }
  if (byName[0]) return byName[0].id;

  if (nameOrId.length >= 4) {
    const byPrefix = sessions.filter((session) => session.id.startsWith(nameOrId));
    if (byPrefix.length > 1) {
      throw new Error(`Multiple sessions match the ID prefix "${nameOrId}". Use the full session ID or a unique name.`);
    }
    if (byPrefix[0]) return byPrefix[0].id;
  }

  return null;
}

export function formatSessionDisplay(session: SessionInfo): string {
  const name = session.name || session.id;
  return session.origin === "remote" ? `${name} [remote:${session.remoteHostId || "unknown-host"}]` : name;
}

export function formatSessionList(sessions: SessionInfo[], currentSessionId: string | null, currentCwd: string): string {
  if (!sessions.length) return "No intercom sessions connected.";
  return sessions.map((session) => {
    const tags = [
      session.id === currentSessionId ? "self" : undefined,
      session.cwd === currentCwd ? "same cwd" : undefined,
      session.status,
    ].filter((tag): tag is string => Boolean(tag));
    const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- ${formatSessionDisplay(session)} (${session.id.slice(0, 8)}) - ${session.cwd} (${session.model})${suffix}`;
  }).join("\n");
}

export function detectGitRoot(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function textResult(text: string, structuredContent?: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

export interface CodexIntercomRuntimeOptions {
  clientFactory?: () => IntercomClient;
  prepareConnection?: () => Promise<void>;
  reconnectDelays?: number[];
}

export class CodexIntercomRuntime {
  private client: IntercomClient | null = null;
  private connectPromise: Promise<IntercomClient> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnectEnabled = true;
  private identity: CodexRuntimeIdentity;
  private unread: PendingInboundMessage[] = [];
  private unresolvedAsks = new Map<string, PendingInboundMessage>();
  private replyWaiters = new Map<string, ReplyWaiter>();

  private readonly clientFactory: () => IntercomClient;
  private capturedScopeId: string | undefined;
  private readonly prepareConnection: () => Promise<void>;
  private readonly reconnectDelays: number[];

  constructor(identity: CodexRuntimeIdentity = buildCodexRuntimeIdentity(), options: CodexIntercomRuntimeOptions = {}) {
    this.identity = identity;
    this.capturedScopeId = intercomScopeIdFromEnv();
    this.clientFactory = options.clientFactory ?? (() => new IntercomClient(
      this.capturedScopeId ? { scopeId: this.capturedScopeId } : {},
    ));
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      if (!config.enabled) throw new Error("Intercom disabled");
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.reconnectDelays = options.reconnectDelays?.length ? options.reconnectDelays : [250, 500, 1000, 2000, 5000];
  }

  getIdentity(): CodexRuntimeIdentity {
    return this.identity;
  }

  async connect(): Promise<IntercomClient> {
    this.reconnectEnabled = true;
    this.clearReconnectTimer();
    if (this.client?.isConnected()) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectOnce(): Promise<IntercomClient> {
    await this.prepareConnection();
    const client = this.clientFactory();
    client.on("message", (from: SessionInfo, message: Message, deliveryId: string) => {
      this.handleIncomingMessage(from, message);
      client.acknowledgeMessage(deliveryId);
    });
    client.on("disconnected", (error: Error) => {
      for (const waiter of this.replyWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.reject(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      }
      this.replyWaiters.clear();
      if (this.client === client) this.client = null;
      this.scheduleReconnect();
    });
    await client.connect({
      name: this.identity.name,
      cwd: this.identity.cwd,
      model: this.identity.model,
      pid: process.pid,
      startedAt: this.identity.startedAt,
      lastActivity: Date.now(),
      status: "idle",
    }, this.identity.sessionId);
    this.client = client;
    this.reconnectAttempt = 0;
    return client;
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)]!;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().then((client) => {
        if (!client.isConnected()) {
          this.reconnectAttempt += 1;
          this.scheduleReconnect();
        }
      }).catch(() => {
        this.reconnectAttempt += 1;
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

  async disconnect(): Promise<void> {
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // A failed in-progress connection is already closed.
      }
    }
    const client = this.client;
    this.client = null;
    if (client) await client.disconnect();
  }

  async switchRuntimeScope(nextScopeId: string, managerSessionId?: string): Promise<void> {
    if (managerSessionId) process.env.AGENT_INTERCOM_MANAGER_TARGET = managerSessionId;
    else delete process.env.AGENT_INTERCOM_MANAGER_TARGET;
    if (this.capturedScopeId === nextScopeId && process.env.AGENT_INTERCOM_SCOPE_ID === nextScopeId) {
      return;
    }
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try { await this.connectPromise; } catch { /* ignore in-flight connect */ }
    }
    const previous = this.client;
    this.client = null;
    if (previous) await previous.disconnect().catch(() => undefined);
    this.capturedScopeId = nextScopeId;
    process.env.AGENT_INTERCOM_SCOPE_ID = nextScopeId;
    this.reconnectEnabled = true;
    await this.connect();
  }

  async join(name?: string, create = false, members?: string[], work?: string): Promise<ToolResult> {
    try {
      if (!name?.trim()) {
        if (create || members?.length || work !== undefined) throw new Error("Creating or extending a team requires a name");
        return textResult(formatJoinableNamedTeamList(listNamedTeams()));
      }
      const client = await this.connect();
      const sessions = await client.listSessions();
      const memberIds = (members ?? []).map((member) => {
        const id = resolveSessionTarget(sessions, member);
        if (!id) throw new Error(`Session "${member}" is not connected`);
        return id;
      });
      const team = await appendNamedTeamMembership({ name: parseTeamName(name), selfId: this.identity.sessionId, members: memberIds, create, work });
      const roster = namedTeamRoster(team, this.identity.sessionId, sessions);
      const notice = create ? formatCreateSuccess({ team: team.name, name: this.identity.name }) : formatNamedJoinSuccess({ team: team.name, name: this.identity.name });
      return textResult(`${notice}\nOther team memberships are unchanged.`, { ok: true, team: team.name, role: roster.self.isManager ? "manager" : "member", roster });
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }
  }

  private handleIncomingMessage(from: SessionInfo, message: Message): void {
    const waiter = this.replyWaiters.get(message.replyTo ?? "");
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
      if (fromMatches && message.content.team === waiter.team) {
        this.replyWaiters.delete(waiter.replyTo);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.resolve(message);
        return;
      }
    }

    const entry = { from, message, receivedAt: Date.now(), read: false };
    this.unread.push(entry);
    if (message.expectsReply) {
      this.unresolvedAsks.set(message.id, entry);
    }
  }

  private waitForReply(from: string, replyTo: string, timeoutMs = getAskTimeoutMs(), signal?: AbortSignal, team?: string): Promise<Message> {
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
        this.replyWaiters.delete(replyTo);
        cleanup();
        void this.client?.cancelAsk(replyTo);
        reject(new Error("intercom_ask cancelled"));
      };
      timeout = setTimeout(() => {
        this.replyWaiters.delete(replyTo);
        void this.client?.deferAsk(replyTo);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.replyWaiters.set(replyTo, { from, replyTo, team, resolve, reject, timeout, cleanup });
    });
  }

  private async resolveTarget(to: string): Promise<string> {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }

  async whoami(): Promise<ToolResult> {
    const client = await this.connect();
    const sessionId = client.sessionId ?? this.identity.sessionId;
    return textResult(
      `session_id: ${sessionId}\nname: ${this.identity.name}\ncwd: ${this.identity.cwd}`,
      { session_id: sessionId, name: this.identity.name, cwd: this.identity.cwd, model: this.identity.model },
    );
  }

  async team(name?: string): Promise<ToolResult> {
    const client = await this.connect();
    const sessions = await client.listSessions();
    const mine = sessionNamedTeams(this.identity.sessionId);
    const selected = name ? mine.filter((entry) => entry.name === name) : mine;
    if (name && !selected.length) return textResult(`You do not belong to team "${name}"`, { ok: false }, true);
    if (selected.length) {
      const teams = selected.map((entry) => namedTeamRoster(entry, this.identity.sessionId, sessions));
      return textResult(teams.map(formatNamedTeamRoster).join("\n\n"), { teams });
    }
    const team = await resolveIntercomTeam({ selfId: client.sessionId ?? this.identity.sessionId, sessions });
    return textResult(formatIntercomTeam(team), team as unknown as Record<string, unknown>);
  }

  async status(): Promise<ToolResult> {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return textResult(
      `Connected: ${client.isConnected() ? "Yes" : "No"}\nSession ID: ${client.sessionId ?? "unknown"}\nActive sessions: ${sessions.length}\nUnread messages: ${this.unread.filter((entry) => !entry.read).length}\nPending asks: ${this.unresolvedAsks.size}`,
      {
        connected: client.isConnected(),
        session_id: client.sessionId,
        active_sessions: sessions.length,
        unread_messages: this.unread.filter((entry) => !entry.read).length,
        pending_asks: this.unresolvedAsks.size,
      },
    );
  }

  async list(scope: "machine" | "directory" | "repo" = "machine", includeSelf = false): Promise<ToolResult> {
    const client = await this.connect();
    let sessions = await client.listSessions();
    if (scope === "directory") {
      sessions = sessions.filter((session) => session.cwd === this.identity.cwd);
    } else if (scope === "repo") {
      const currentRoot = detectGitRoot(this.identity.cwd);
      sessions = currentRoot
        ? sessions.filter((session) => detectGitRoot(session.cwd) === currentRoot)
        : [];
    }
    if (!includeSelf) {
      sessions = sessions.filter((session) => session.id !== client.sessionId);
    }
    return textResult(formatSessionList(sessions, client.sessionId, this.identity.cwd), { sessions });
  }

  async setSummary(summary: string): Promise<ToolResult> {
    const client = await this.connect();
    client.updatePresence({ status: summary.trim() || "idle" });
    return textResult("Summary updated.", { ok: true, summary });
  }

  async send(to: string, message: string, attachments?: Attachment[], replyTo?: string, requestedTeam?: string): Promise<ToolResult> {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const source = replyTo ? this.unread.find((entry) => entry.message.id === replyTo && entry.from.id === sendTo) : undefined;
    if (replyTo && !source) throw new Error("Unknown inbound reply context");
    if (source && requestedTeam !== undefined && requestedTeam !== source.message.content.team) throw new Error("Reply team must match the original message");
    const team = source ? source.message.content.team : resolveNamedMessageTeam(this.identity.sessionId, sendTo, requestedTeam);
    const result = await client.send(sendTo, { text: message, attachments, replyTo: source?.message.expectsReply ? replyTo : undefined, team });
    if (!result.delivered) {
      return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
    }
    if (replyTo) this.unresolvedAsks.delete(replyTo);
    return textResult(`Message sent to ${to}.`, { ok: true, message_id: result.id, to });
  }

  async ask(to: string, message: string, attachments?: Attachment[], timeoutMs = getAskTimeoutMs(), signal?: AbortSignal, requestedTeam?: string): Promise<ToolResult> {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const team = resolveNamedMessageTeam(this.identity.sessionId, sendTo, requestedTeam);
    const questionId = randomUUID();
    const replyPromise = this.waitForReply(sendTo, questionId, timeoutMs, signal, team);
    void replyPromise.catch(() => undefined);
    try {
      const result = await client.send(sendTo, {
        messageId: questionId,
        text: message,
        attachments,
        expectsReply: true,
        team,
      });
      if (!result.delivered) {
        this.replyWaiters.get(questionId)?.reject(new Error(result.reason ?? "Session may not exist or has disconnected."));
        this.replyWaiters.delete(questionId);
        client.cancelAsk(questionId);
        return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
      }
      const reply = await replyPromise;
      const replyText = `${reply.content.text}${formatAttachments(reply.content.attachments)}`;
      return textResult(`Reply from ${to}:\n${replyText}`, { ok: true, message_id: result.id, reply });
    } catch (error) {
      client.cancelAsk(questionId);
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }
  }

  async pending(markRead = false): Promise<ToolResult> {
    const unreadMessages = this.unread.filter((entry) => !entry.read);
    if (markRead) {
      for (const entry of unreadMessages) entry.read = true;
    }
    const pendingAsks = Array.from(this.unresolvedAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
    const lines = [
      unreadMessages.length
        ? unreadMessages.map((entry) => `- ${formatSessionDisplay(entry.from)}${replyHint(entry)}: ${entry.message.content.text}${formatAttachments(entry.message.content.attachments)}`).join("\n")
        : "No unread messages.",
      pendingAsks.length
        ? `\nPending asks:\n${pendingAsks.map((entry) => {
          const selector = pendingSelector(pendingAsks, entry);
          return `- ${formatSessionDisplay(entry.from)}${replyHint(entry)}${selector ? ` [${selector}]` : ""}: ${entry.message.content.text}`;
        }).join("\n")}`
        : "",
    ].filter(Boolean);
    return textResult(lines.join("\n"), {
      unread_messages: unreadMessages.map((entry) => publicPendingEntry(entry)),
      pending_asks: pendingAsks.map((entry) => publicPendingEntry(entry, pendingSelector(pendingAsks, entry))),
    });
  }

  async reply(message: string, to?: string, which?: ReplyWhich, askId?: string, contextId?: string, team?: string): Promise<ToolResult> {
    let target: PendingInboundMessage;
    try {
      target = selectReplyContext(this.unread, Array.from(this.unresolvedAsks.values()), { to, which, askId, contextId, team });
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }

    const result = await this.send(target.from.id, message, undefined, target.message.id);
    if (!result.isError) {
      this.unresolvedAsks.delete(target.message.id);
    }
    return result;
  }
}
