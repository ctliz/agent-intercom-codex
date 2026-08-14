import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { types as nodeUtilTypes } from "node:util";
import { CodexBridgeDaemon } from "./bridge-daemon.ts";
import { intercomScopeIdFromEnv } from "../protocol-v4/contract.ts";
import {
  assertHardenedBossAgentConfig,
  parseHardenedBossClientKind,
  type BridgeAgentConfig,
  type BridgeConfig,
} from "./bridge-config.ts";
import { assertHardenedBossProviderAuthority, type HardenedBossClientKind } from "./boss-client.ts";
import { assertBossCanonicalData } from "../broker/boss-adapter.ts";
import { ensureIntercomRuntimeDir, getIntercomDirPath } from "../broker/paths.ts";
import { copyTextToClipboard, copyTextToTerminalClipboard } from "./clipboard.ts";
import { formatContactInstruction } from "./contact.ts";
import { TuiInputDecoder } from "./tui-input.ts";

export interface CoiOptions {
  id?: string;
  name?: string;
  cwd: string;
  instructions?: string;
  socketPath?: string;
  statePath?: string;
  noTui: boolean;
  copyShortcut: boolean;
  codexCommand: string;
  codexArgs: string[];
}

interface IdentityInput {
  cwd: string;
  pid: number;
  gitRoot?: string | null;
  branch?: string | null;
}

interface BridgeRuntimeConfig {
  approvalPolicy?: string;
  sandboxPolicy?: Record<string, unknown>;
}

const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--ask-for-approval",
  "--add-dir",
  "--disable",
  "--enable",
  "-c",
  "--cd",
  "-C",
  "--config",
  "-i",
  "--image",
  "-m",
  "--model",
  "-p",
  "--profile",
  "--remote-auth-token-env",
  "-s",
  "--sandbox",
  "--local-provider",
]);
const COI_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MANAGED_MCP_ENV_KEYS = [
  "AGENT_INTERCOM_WORKER_ID",
  "AGENT_INTERCOM_WORKER_INCARNATION_ID",
  "AGENT_INTERCOM_WORKER_GENERATION",
  "AGENT_INTERCOM_RUN_ID",
  "AGENT_INTERCOM_BOSS_RUN_ID",
  "AGENT_INTERCOM_PARTICIPANT_ID",
  "AGENT_INTERCOM_BINDING_EPOCH",
  "AGENT_INTERCOM_MANAGER_TARGET",
  "AGENT_INTERCOM_MANAGER_SESSION_ID",
  "AGENT_INTERCOM_SYSTEMD_UNIT",
  "AGENT_INTERCOM_OWNED",
  "AGENT_INTERCOM_AGENT_DIR",
] as const;

export function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "codex";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function gitString(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed || null;
}

export function createDefaultIdentity(input: IdentityInput): { id: string; name: string } {
  const root = input.gitRoot || input.cwd;
  const repo = basename(root) || "codex";
  const branch = input.branch || "worktree";
  const readable = `${repo}:${branch}`;
  const suffix = `${shortHash(input.cwd)}-${input.pid}`;
  return {
    id: sanitizeSegment(`codex-${repo}-${branch}-${suffix}`),
    name: `codex:${readable}#${input.pid}`,
  };
}

function detectIdentity(cwd: string): { id: string; name: string } {
  return createDefaultIdentity({
    cwd,
    pid: process.pid,
    gitRoot: gitString(cwd, ["rev-parse", "--show-toplevel"]),
    branch: gitString(cwd, ["branch", "--show-current"]),
  });
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return defaultValue;
}

function camelSandboxType(mode: string): string {
  switch (mode) {
    case "read-only":
      return "readOnly";
    case "workspace-write":
      return "workspaceWrite";
    case "danger-full-access":
      return "dangerFullAccess";
    default:
      throw new Error(`Unsupported sandbox mode: ${mode}`);
  }
}

function readCodexFlagValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
  const arg = args[index];
  const inline = arg.includes("=") ? arg.split(/=(.*)/s, 2)[1] : undefined;
  if (inline !== undefined) return { value: inline, nextIndex: index };
  return { value: readValue(args, index, option), nextIndex: index + 1 };
}

export function deriveBridgeAgentRuntimeConfig(args: string[], cwd: string): BridgeRuntimeConfig {
  let approvalPolicy: string | undefined;
  let sandboxMode: string | undefined;
  const writableRoots = new Set<string>([resolve(cwd)]);

  const { optionArgs } = splitCodexResumeArgs(args);
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

    switch (optionName) {
      case "--ask-for-approval":
      case "-a": {
        const parsed = readCodexFlagValue(optionArgs, index, optionName);
        approvalPolicy = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--sandbox":
      case "-s": {
        const parsed = readCodexFlagValue(optionArgs, index, optionName);
        sandboxMode = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--add-dir": {
        const parsed = readCodexFlagValue(optionArgs, index, optionName);
        writableRoots.add(resolve(cwd, parsed.value));
        index = parsed.nextIndex;
        break;
      }
      case "--dangerously-bypass-approvals-and-sandbox":
      case "--yolo":
        approvalPolicy = "never";
        sandboxMode = "danger-full-access";
        break;
      default:
        break;
    }
  }

  const sandboxType = sandboxMode ? camelSandboxType(sandboxMode) : undefined;
  const sandboxPolicy = sandboxType === "workspaceWrite"
    ? { type: sandboxType, writableRoots: [...writableRoots], networkAccess: false }
    : sandboxType
      ? { type: sandboxType, ...(sandboxType === "readOnly" ? { networkAccess: false } : {}) }
      : undefined;

  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
  };
}

const HARDENED_BOSS_RAW_CONFIG_OPTIONS = new Set(["-c", "--config", "-p", "--profile", "--enable", "--disable"]);
const HARDENED_BOSS_BYPASS_OPTIONS = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
]);

function isHardenedBossRawConfigOption(optionName: string): boolean {
  return HARDENED_BOSS_RAW_CONFIG_OPTIONS.has(optionName)
    || (optionName.startsWith("-c") && optionName !== "-C")
    || optionName.startsWith("-p");
}

function hardenedBossAttachedAuthorityOption(arg: string): "-s" | "-a" | "-C" | undefined {
  if (arg.length <= 2) return undefined;
  const option = arg.slice(0, 2);
  return option === "-s" || option === "-a" || option === "-C" ? option : undefined;
}

/** Validate every user-controlled launch escape before an app-server exists. */
export function assertHardenedBossCoiLaunch(
  args: string[],
  cwd: string,
  bossClient: HardenedBossClientKind | undefined,
): BridgeRuntimeConfig {
  if (bossClient !== undefined) {
    assertBossCanonicalData(args, "$.argv");
    if (!Array.isArray(args) || nodeUtilTypes.isProxy(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error(`${bossClient} arguments must be a plain dense string array`);
    }
  }
  if (bossClient === undefined) return deriveBridgeAgentRuntimeConfig(args, cwd);
  let afterSeparator = false;
  for (const arg of args) {
    if (arg === "--") {
      afterSeparator = true;
      continue;
    }
    const attachedAuthorityOption = hardenedBossAttachedAuthorityOption(arg);
    if (attachedAuthorityOption === "-C") {
      throw new Error(`${bossClient} cannot expand or replace its writable root`);
    }
    if (attachedAuthorityOption !== undefined) {
      throw new Error(`${bossClient} cannot use attached ${attachedAuthorityOption} policy overrides`);
    }
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (isHardenedBossRawConfigOption(optionName)) {
      throw new Error(`${bossClient} cannot use raw ${optionName} or profile configuration`);
    }
    if (HARDENED_BOSS_BYPASS_OPTIONS.has(optionName)) {
      throw new Error(`${bossClient} cannot use approval or sandbox bypass aliases`);
    }
    if (optionName === "--add-dir" || optionName === "--cd" || optionName === "-C") {
      throw new Error(`${bossClient} cannot expand or replace its writable root`);
    }
    if (afterSeparator && ["--sandbox", "-s", "--ask-for-approval", "-a"].includes(optionName)) {
      throw new Error(`${bossClient} cannot place policy overrides after the argument separator`);
    }
    if (optionName.startsWith("-") && /(?:yolo|danger|bypass)/i.test(optionName)) {
      throw new Error(`${bossClient} cannot use approval or sandbox bypass aliases`);
    }
  }
  if (bossClient === "boss_participant") {
    throw new Error("boss_participant requires unavailable broker-owned assigned workspace authority");
  }
  const runtime = deriveBridgeAgentRuntimeConfig(args, cwd);
  const probe: BridgeAgentConfig = {
    id: "launch-validation",
    name: "launch-validation",
    cwd: resolve(cwd),
    bossClient,
    ...runtime,
  };
  assertHardenedBossAgentConfig(probe);
  return runtime;
}

export function parseCoiArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CoiOptions {
  const codexArgs: string[] = [];
  const options: Partial<CoiOptions> = {};
  let afterSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (afterSeparator) {
      codexArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      afterSeparator = true;
      codexArgs.push(arg);
      continue;
    }

    const [key, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = inlineValue ?? null;

    switch (key) {
      case "--name":
      case "--intercom-name":
        options.name = value ?? readValue(argv, index++, key);
        break;
      case "--id":
      case "--intercom-id":
        options.id = value ?? readValue(argv, index++, key);
        break;
      case "--cwd":
      case "--intercom-cwd":
        options.cwd = resolve(value ?? readValue(argv, index++, key));
        break;
      case "--instructions":
      case "--intercom-instructions":
        options.instructions = value ?? readValue(argv, index++, key);
        break;
      case "--socket":
      case "--intercom-socket":
        options.socketPath = resolve(value ?? readValue(argv, index++, key));
        break;
      case "--state":
      case "--intercom-state":
        options.statePath = resolve(value ?? readValue(argv, index++, key));
        break;
      case "--no-tui":
      case "--intercom-no-tui":
        options.noTui = true;
        break;
      case "--no-intercom-shortcut":
      case "--intercom-no-shortcut":
        options.copyShortcut = false;
        break;
      case "--intercom-shortcut":
        options.copyShortcut = true;
        break;
      default:
        codexArgs.push(arg);
        break;
    }
  }

  return {
    cwd: resolve(options.cwd ?? env.CODEX_INTERCOM_CWD ?? process.cwd()),
    id: options.id ?? env.CODEX_INTERCOM_SESSION_ID,
    name: options.name ?? env.CODEX_INTERCOM_NAME,
    instructions: options.instructions ?? env.CODEX_INTERCOM_INSTRUCTIONS,
    socketPath: options.socketPath,
    statePath: options.statePath,
    noTui: options.noTui ?? false,
    copyShortcut: options.copyShortcut ?? envFlagEnabled(env.CODEX_INTERCOM_SHORTCUT, true),
    codexCommand: env.CODEX_INTERCOM_CODEX_COMMAND || "codex",
    codexArgs,
  };
}

export function hasCodexHelpOrVersion(args: string[]): boolean {
  return splitCodexResumeArgs(args).optionArgs.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V");
}

export function splitCodexResumeArgs(args: string[]): { optionArgs: string[]; promptArgs: string[]; separatorPresent: boolean } {
  const optionArgs: string[] = [];
  const promptArgs: string[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      promptArgs.push(...args.slice(index + 1));
      return { optionArgs, promptArgs, separatorPresent: true };
    }
    if (!arg.startsWith("-") || arg === "-") break;
    optionArgs.push(arg);
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!arg.includes("=") && CODEX_OPTIONS_WITH_VALUE.has(optionName) && index + 1 < args.length) {
      optionArgs.push(args[index + 1]);
      index += 1;
    }
  }
  promptArgs.push(...args.slice(index));
  return { optionArgs, promptArgs, separatorPresent: false };
}

export function resolveCoiResumeRequest(args: string[]): {
  optionArgs: string[];
  promptArgs: string[];
  threadId?: string;
} {
  const { optionArgs, promptArgs, separatorPresent } = splitCodexResumeArgs(args);
  if (separatorPresent || promptArgs[0] !== "resume" || !promptArgs[1]) return { optionArgs, promptArgs };
  return { optionArgs, threadId: promptArgs[1], promptArgs: promptArgs.slice(2) };
}

export function buildCoiTuiArgs(
  remote: string,
  optionArgs: string[],
  threadId: string,
  promptArgs: string[],
  explicitResume: boolean,
): string[] {
  const promptTail = promptArgs.length === 0 ? [] : ["--", ...promptArgs];
  return explicitResume
    ? ["resume", "--remote", remote, ...optionArgs, threadId, ...promptTail]
    : ["--remote", remote, ...optionArgs, ...promptTail];
}

export function buildCodexAppServerArgs(
  args: string[],
  socketPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const { optionArgs } = splitCodexResumeArgs(args);
  const appServerArgs: string[] = [];

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (optionName === "--strict-config") {
      appServerArgs.push(arg);
      continue;
    }
    if (optionName !== "-c" && optionName !== "--config" && optionName !== "--enable" && optionName !== "--disable") {
      continue;
    }
    appServerArgs.push(arg);
    if (!arg.includes("=") && index + 1 < optionArgs.length) {
      appServerArgs.push(optionArgs[index + 1]);
      index += 1;
    }
  }

  for (const key of MANAGED_MCP_ENV_KEYS) {
    const value = env[key];
    if (value) appServerArgs.push("-c", `mcp_servers.codex-intercom.env.${key}=${JSON.stringify(value)}`);
  }

  return ["app-server", ...appServerArgs, "--listen", `unix://${socketPath}`];
}

async function waitForSocket(socketPath: string, proc: ChildProcess, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Codex app-server exited before creating ${socketPath}`);
    }
    if (existsSync(socketPath)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for Codex app-server socket: ${socketPath}`);
}

async function stopChild(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 2000);
    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

function terminalNotification(message: string): void {
  const safe = message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
  if (process.stdout.isTTY) process.stdout.write(`\x1b]9;${safe}\x1b\\`);
  else process.stderr.write(`${safe}\n`);
}

export async function runInteractiveTui(
  command: string,
  args: string[],
  refreshArgs: string[],
  cwd: string,
  onAltI?: (controls: { insertText(text: string): void }) => void,
  onAltM?: (controls: { insertText(text: string): void }) => void,
  installRefresh?: (refresh: () => void) => () => void,
  protectedBossClient?: HardenedBossClientKind,
  launchEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  // This also runs on the recursive refresh path below, so a future caller
  // cannot reintroduce an ambient-PATH spawn after the initial preflight.
  assertHardenedBossProviderAuthority(protectedBossClient);
  const runInherited = async (): Promise<number> => {
    const tui = spawn(command, args, { cwd, env: launchEnv, stdio: "inherit" });
    const [code, signal] = await once(tui, "exit") as [number | null, NodeJS.Signals | null];
    if (typeof code === "number") return code;
    return signal === "SIGINT" ? 130 : 1;
  };

  if ((!onAltI && !onAltM) || !process.stdin.isTTY || !process.stdout.isTTY) {
    return runInherited();
  }

  let nodePty: typeof import("node-pty");
  try {
    nodePty = await import("node-pty");
  } catch (error) {
    process.stderr.write(`coi: Alt+I unavailable because optional node-pty could not load: ${error instanceof Error ? error.message : String(error)}\n`);
    return runInherited();
  }

  const tui = nodePty.spawn(command, args, {
    name: launchEnv.TERM || "xterm-256color",
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd,
    env: launchEnv,
  });
  const outputSubscription = tui.onData((data) => process.stdout.write(data));
  let refreshRequested = false;
  const removeRefresh = installRefresh?.(() => {
    if (refreshRequested) return;
    refreshRequested = true;
    terminalNotification("Intercom turn completed; refreshing Codex TUI");
    tui.kill();
  });
  const previousRawMode = Boolean(process.stdin.isRaw);
  const inputDecoder = new TuiInputDecoder();
  let pendingTimer: NodeJS.Timeout | null = null;

  const flushPending = () => {
    const pending = inputDecoder.flushPendingEscape();
    if (!pending) return;
    try {
      tui.write(pending);
    } catch {
      // The PTY may have closed while a partial escape sequence was buffered.
    }
    pendingTimer = null;
  };
  const onInput = (chunk: Buffer | string) => {
    if (pendingTimer) clearTimeout(pendingTimer);
    const filtered = inputDecoder.write(chunk);
    if (filtered.forwarded) tui.write(filtered.forwarded);
    const controls = {
      insertText(text: string) {
        const safe = text.replace(/\x1b/g, "");
        tui.write(`\x1b[200~${safe}\x1b[201~`);
      },
    };
    for (let index = 0; index < filtered.altICount; index += 1) onAltI?.(controls);
    for (let index = 0; index < filtered.altMCount; index += 1) onAltM?.(controls);
    pendingTimer = inputDecoder.hasPendingEscape() ? setTimeout(flushPending, 25) : null;
  };
  const onResize = () => tui.resize(process.stdout.columns || 80, process.stdout.rows || 24);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.stdout.on("resize", onResize);

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve) => {
      tui.onExit(({ exitCode, signal }) => resolve(exitCode ?? (signal === 2 ? 130 : 1)));
    });
  } finally {
    removeRefresh?.();
    if (pendingTimer) clearTimeout(pendingTimer);
    flushPending();
    const ended = inputDecoder.end();
    if (ended.forwarded) {
      try {
        tui.write(ended.forwarded);
      } catch {
        // The PTY is already closed.
      }
    }
    process.stdin.off("data", onInput);
    process.stdout.off("resize", onResize);
    process.stdin.setRawMode(previousRawMode);
    outputSubscription.dispose();
  }
  if (refreshRequested) {
    return runInteractiveTui(command, refreshArgs, refreshArgs, cwd, onAltI, onAltM, installRefresh, protectedBossClient, launchEnv);
  }
  return exitCode;
}

export function cleanupOldCoiStateFiles(intercomDir: string, now = Date.now(), maxAgeMs = COI_STATE_MAX_AGE_MS): void {
  let entries: string[];
  try {
    entries = readdirSync(intercomDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!/^coi-.+-state\.json$/.test(entry)) continue;
    const path = join(intercomDir, entry);
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs > maxAgeMs) rmSync(path, { force: true });
    } catch {
      // Best effort cleanup only.
    }
  }
}

export function resetCoiStateForFreshStart(statePath: string, fresh: boolean): void {
  if (fresh) rmSync(statePath, { force: true });
}

export async function runCoi(options: CoiOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const scopeId = intercomScopeIdFromEnv(env);
  const bossClient = parseHardenedBossClientKind(env.CODEX_INTERCOM_BOSS_CLIENT?.trim(), "CODEX_INTERCOM_BOSS_CLIENT");
  // No provider executable/artifact authority is broker-owned yet. Fail
  // before help, app-server, headless, TUI, refresh, or runtime-file setup.
  assertHardenedBossProviderAuthority(bossClient);
  if (bossClient !== undefined && options.codexCommand !== "codex") {
    throw new Error(`${bossClient} cannot use a caller-provided Codex/app-server command`);
  }
  const runtimeConfig = assertHardenedBossCoiLaunch(options.codexArgs, options.cwd, bossClient);
  if (hasCodexHelpOrVersion(options.codexArgs)) {
    const help = spawn(options.codexCommand, options.codexArgs, {
      cwd: options.cwd,
      env,
      stdio: "inherit",
    });
    const [code, signal] = await once(help, "exit") as [number | null, NodeJS.Signals | null];
    if (typeof code === "number") return code;
    return signal === "SIGINT" ? 130 : 1;
  }

  ensureIntercomRuntimeDir();
  const identity = detectIdentity(options.cwd);
  const id = sanitizeSegment(options.id ?? identity.id);
  const name = options.name ?? identity.name;
  const intercomDir = getIntercomDirPath();
  cleanupOldCoiStateFiles(intercomDir);
  const socketPath = options.socketPath ?? join(intercomDir, `coi-${process.pid}.sock`);
  const statePath = options.statePath ?? join(intercomDir, `coi-${sanitizeSegment(id)}-state.json`);
  const fresh = env.AGENT_INTERCOM_FRESH === "1";
  resetCoiStateForFreshStart(statePath, fresh);
  rmSync(socketPath, { force: true });

  const resumeRequest = resolveCoiResumeRequest(options.codexArgs);
  const agent: BridgeAgentConfig = {
    id,
    name,
    cwd: options.cwd,
    model: env.CODEX_INTERCOM_MODEL,
    instructions: options.instructions,
    threadId: fresh ? undefined : resumeRequest.threadId,
    ...(bossClient === undefined ? {} : { bossClient }),
    ...runtimeConfig,
  };
  assertHardenedBossAgentConfig(agent);

  const appServer = spawn(options.codexCommand, buildCodexAppServerArgs(options.codexArgs, socketPath, env), {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  appServer.stderr?.on("data", (chunk) => {
    if (env.CODEX_INTERCOM_DEBUG) process.stderr.write(String(chunk));
  });

  const cleanup = async () => {
    await daemon?.stop().catch(() => undefined);
    await stopChild(appServer);
    rmSync(socketPath, { force: true });
  };

  let daemon: CodexBridgeDaemon | null = null;
  let cleaned = false;
  const cleanupOnce = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanup();
  };

  process.once("SIGINT", () => {
    void cleanupOnce().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void cleanupOnce().finally(() => process.exit(143));
  });

  await waitForSocket(socketPath, appServer);

  const config: BridgeConfig = {
    statePath,
    appServer: {
      transport: "unix-websocket",
      socketPath,
    },
    agents: [agent],
  };
  let refreshVisibleTui: (() => void) | undefined;
  daemon = new CodexBridgeDaemon(config, {
    onExternalTurnComplete: ({ from, response }) => {
      terminalNotification(`Intercom turn from ${from.name || from.id} completed: ${response}`);
      setTimeout(() => refreshVisibleTui?.(), 1000).unref();
    },
  }, scopeId);
  await daemon.start();
  process.stderr.write(`coi intercom session: ${name} (${id})\n`);

  if (options.noTui) {
    await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM"), once(appServer, "exit")]);
    await cleanupOnce();
    return 0;
  }

  const remote = `unix://${socketPath}`;
  const threadId = await daemon.ensureThreadForAgent(id);
  const { optionArgs, promptArgs } = resumeRequest;
  process.stderr.write(`coi sidecar thread: ${threadId}\n`);
  const resolvedTuiArgs = buildCoiTuiArgs(
    remote,
    optionArgs,
    threadId,
    promptArgs,
    Boolean(resumeRequest.threadId) && !fresh,
  );
  const refreshTuiArgs = ["resume", "--remote", remote, ...optionArgs, threadId];
  let copying = false;
  const copyCurrentContact = (controls: { insertText(text: string): void }) => {
    if (copying) return;
    copying = true;
    void daemon!.getContactTargetForAgent(id)
      .then(async (contact) => {
        const instruction = formatContactInstruction(contact);
        const preferTerminal = Boolean(env.SSH_TTY || env.SSH_CONNECTION);
        let copied = preferTerminal
          ? copyTextToTerminalClipboard(instruction, (sequence) => process.stdout.write(sequence))
          : await copyTextToClipboard(instruction);
        if (!copied.ok && process.stdout.isTTY) {
          copied = copyTextToTerminalClipboard(instruction, (sequence) => process.stdout.write(sequence));
        }

        if (copied.ok) {
          const fallback = contact.fallback ? " using the stable ID" : "";
          terminalNotification(`Copied intercom contact${fallback}: ${contact.target}`);
          return;
        }

        controls.insertText(instruction);
        terminalNotification(`Clipboard unavailable; inserted intercom contact: ${contact.target}`);
      })
      .catch((error) => terminalNotification(`Failed to read intercom contact: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        copying = false;
      });
  };
  const openIntercom = (controls: { insertText(text: string): void }) => {
    controls.insertText("Use intercom_list to show the active sessions, then ask me which session to message and what to send. Use intercom_send after I choose.");
    terminalNotification("Inserted intercom session picker request");
  };
  try {
    return await runInteractiveTui(
      options.codexCommand,
      resolvedTuiArgs,
      refreshTuiArgs,
      options.cwd,
      options.copyShortcut ? copyCurrentContact : undefined,
      options.copyShortcut ? openIntercom : undefined,
      (refresh) => {
        refreshVisibleTui = refresh;
        return () => {
          if (refreshVisibleTui === refresh) refreshVisibleTui = undefined;
        };
      },
      bossClient,
      env,
    );
  } finally {
    await cleanupOnce();
  }
}

async function main(): Promise<void> {
  const options = parseCoiArgs(process.argv.slice(2));
  const code = await runCoi(options);
  process.exit(code);
}

if (process.argv[1] && (basename(process.argv[1]) === "coi.ts" || basename(process.argv[1]) === "coi.mjs")) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
