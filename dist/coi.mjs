#!/usr/bin/env node
process.stderr.write("[agent-intercom-build] package=@ctliz/agent-intercom-codex version=0.12.0-connect.1 target=coi sourceSha256=f5d619a0fa1debe9fa5b5850ec8d372a474488d0fb4bde6540cd7656f6bb2c51\n");

// codex/coi.ts
import { once as once2 } from "node:events";
import { spawn as spawn4, spawnSync as spawnSync2 } from "node:child_process";
import { createHash as createHash4 } from "node:crypto";
import { existsSync as existsSync6, readdirSync, rmSync, statSync } from "node:fs";
import { basename as basename2, join as join8, resolve as resolve4 } from "node:path";
import { setTimeout as delay2 } from "node:timers/promises";
import { types as nodeUtilTypes4 } from "node:util";

// codex/bridge-daemon.ts
import { once } from "node:events";
import { randomUUID as randomUUID4 } from "node:crypto";
import { basename } from "node:path";

// codex/app-server-client.ts
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import net from "node:net";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// codex/boss-client.ts
var HARDENED_BOSS_CODEX_DEFAULTS = Object.freeze({
  boss_participant: Object.freeze({ approvalPolicy: "untrusted", sandbox: "workspace-write" }),
  boss_reviewer: Object.freeze({ approvalPolicy: "untrusted", sandbox: "read-only" })
});
var PROVIDER_AUTHORITY_UNAVAILABLE = "PROVIDER_AUTHORITY_UNAVAILABLE";
var ProviderAuthorityUnavailableError = class extends Error {
  constructor(bossClient) {
    super(`${PROVIDER_AUTHORITY_UNAVAILABLE}: ${bossClient} requires a broker-owned, artifact-attested Codex provider executable`);
    this.bossClient = bossClient;
    this.name = "ProviderAuthorityUnavailableError";
  }
  bossClient;
  code = PROVIDER_AUTHORITY_UNAVAILABLE;
};
function assertHardenedBossProviderAuthority(bossClient) {
  if (bossClient !== void 0) throw new ProviderAuthorityUnavailableError(bossClient);
}

// codex/app-server-client.ts
var DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1e3;
var MAX_WEBSOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;
var UNIX_WEBSOCKET_CONNECT_TIMEOUT_MS = 1e4;
function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
function defaultServerRequestResponse(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/call":
      return { contentItems: [{ type: "text", text: "Background bridge declined tool call." }], success: false };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "denied" };
    default:
      throw new Error(`Unsupported app-server request: ${method}`);
  }
}
var CodexAppServerClient = class extends EventEmitter {
  proc = null;
  socket = null;
  wsDecoder = new WebSocketFrameDecoder();
  rl = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  initialized = false;
  options;
  constructor(options = {}, protectedBossClient) {
    super();
    assertHardenedBossProviderAuthority(protectedBossClient);
    this.options = {
      command: options.command ?? "codex",
      args: options.args ?? ["app-server"],
      transport: options.transport ?? "stdio",
      socketPath: options.socketPath ?? "",
      serverRequestHandler: options.serverRequestHandler ?? defaultServerRequestResponseFromMessage,
      startDaemon: options.startDaemon ?? false,
      startDaemonCommand: options.startDaemonCommand ?? "codex",
      startDaemonArgs: options.startDaemonArgs ?? ["app-server", "daemon", "start"],
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      env: options.env ?? process.env
    };
  }
  setServerRequestHandler(handler) {
    this.options.serverRequestHandler = handler;
  }
  async connect() {
    if (this.proc) return;
    if (this.options.startDaemon) {
      const started = spawnSync(this.options.startDaemonCommand, this.options.startDaemonArgs, {
        encoding: "utf8",
        env: this.options.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (started.status !== 0) {
        throw new Error(`Failed to start Codex app-server daemon: ${started.stderr || started.stdout || `exit ${started.status}`}`);
      }
    }
    if (this.options.transport === "unix-websocket") {
      await this.connectUnixWebSocket();
      await this.initialize();
      return;
    }
    const proc = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env
    });
    this.proc = proc;
    this.rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.handleLine(line));
    proc.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    proc.once("error", (error) => this.failAll(asError(error)));
    proc.once("exit", (code, signal) => {
      this.failAll(new Error(`Codex app-server proxy exited (${signal ?? code ?? "unknown"})`));
      this.proc = null;
      this.initialized = false;
      this.emit("exit", { code, signal });
    });
    await this.initialize();
  }
  async disconnect() {
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      this.initialized = false;
      this.failAll(new Error("Codex app-server client disconnected"));
      await new Promise((resolve5) => {
        const timeout = setTimeout(() => {
          socket.destroy();
          resolve5();
        }, 1e3);
        socket.once("close", () => {
          clearTimeout(timeout);
          resolve5();
        });
        if (!socket.destroyed) {
          this.writeWebSocketFrame(8, Buffer.alloc(0));
          socket.end();
        }
      });
      return;
    }
    const proc = this.proc;
    this.rl?.close();
    this.rl = null;
    this.proc = null;
    this.initialized = false;
    this.failAll(new Error("Codex app-server client disconnected"));
    if (!proc) return;
    await new Promise((resolve5) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve5();
      }, 2e3);
      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve5();
      });
      proc.stdin.end();
      proc.kill("SIGTERM");
    });
  }
  async initialize() {
    if (this.initialized) return;
    await this.request("initialize", {
      clientInfo: {
        name: "codex_intercom_bridge",
        title: "Codex Intercom Bridge",
        version: "0.1.0"
      },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
    this.initialized = true;
  }
  request(method, params, timeoutMs = this.options.requestTimeoutMs) {
    if (!this.canWrite()) {
      return Promise.reject(new Error("Codex app-server client is not connected"));
    }
    const id = this.nextId++;
    const payload = params === void 0 ? { id, method } : { id, method, params };
    return new Promise((resolve5, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve5, reject, timeout });
      this.writePayload(payload);
    });
  }
  notify(method, params) {
    if (!this.canWrite()) {
      throw new Error("Codex app-server client is not connected");
    }
    const payload = params === void 0 ? { method } : { method, params };
    this.writePayload(payload);
  }
  respond(id, result) {
    if (id === void 0 || id === null) return;
    this.writePayload({ id, result });
  }
  respondError(id, code, message) {
    if (id === void 0 || id === null) return;
    this.writePayload({ id, error: { code, message } });
  }
  canWrite() {
    if (this.options.transport === "unix-websocket") {
      return Boolean(this.socket && !this.socket.destroyed && this.socket.writable);
    }
    return Boolean(this.proc && this.proc.stdin.writable);
  }
  writePayload(payload) {
    const json = JSON.stringify(payload);
    if (this.options.transport === "unix-websocket") {
      this.writeWebSocketFrame(1, Buffer.from(json, "utf8"));
      return;
    }
    this.proc?.stdin.write(`${json}
`);
  }
  async connectUnixWebSocket() {
    const deadline = Date.now() + UNIX_WEBSOCKET_CONNECT_TIMEOUT_MS;
    let lastError = null;
    let attempt = 0;
    while (Date.now() < deadline) {
      try {
        await this.connectUnixWebSocketOnce();
        return;
      } catch (error) {
        lastError = asError(error);
        this.socket?.destroy();
        this.socket = null;
        const code = lastError.code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") throw lastError;
        const backoffMs = Math.min(250, 25 * 2 ** attempt);
        attempt += 1;
        await delay(backoffMs);
      }
    }
    throw new Error(`Codex app-server WebSocket did not become ready within ${Math.round(UNIX_WEBSOCKET_CONNECT_TIMEOUT_MS / 1e3)} seconds${lastError ? `: ${lastError.message}` : ""}`);
  }
  connectUnixWebSocketOnce() {
    const socketPath = this.options.socketPath;
    if (!socketPath) return Promise.reject(new Error("socketPath is required for unix-websocket transport"));
    return new Promise((resolve5, reject) => {
      const key = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      const socket = net.createConnection(socketPath);
      this.socket = socket;
      this.wsDecoder = new WebSocketFrameDecoder();
      let handshake = Buffer.alloc(0);
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          cleanupHandshake();
          reject(error);
          return;
        }
        this.failAll(error);
        this.emit("exit", { code: null, signal: null });
      };
      const onData = (chunk) => {
        if (settled) {
          this.handleWebSocketData(chunk);
          return;
        }
        handshake = Buffer.concat([handshake, chunk]);
        const headerEnd = handshake.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const head = handshake.subarray(0, headerEnd).toString("utf8");
        const rest = handshake.subarray(headerEnd + 4);
        if (!/^HTTP\/1\.1 101\b/im.test(head) || !head.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
          fail(new Error(`Codex app-server WebSocket handshake failed: ${head.split("\r\n")[0] || "invalid response"}`));
          return;
        }
        settled = true;
        cleanupHandshake();
        socket.on("data", (data) => this.handleWebSocketData(data));
        socket.on("error", (error) => fail(error));
        socket.on("close", () => fail(new Error("Codex app-server WebSocket closed")));
        if (rest.length) this.handleWebSocketData(rest);
        resolve5();
      };
      const cleanupHandshake = () => {
        socket.off("data", onData);
        socket.off("error", fail);
      };
      socket.once("connect", () => {
        socket.write([
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n"
        ].join("\r\n"));
      });
      socket.on("data", onData);
      socket.once("error", fail);
    });
  }
  writeWebSocketFrame(opcode, payload) {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return;
    const length = payload.length;
    const lengthBytes = length < 126 ? 0 : length <= 65535 ? 2 : 8;
    const header = Buffer.alloc(2 + lengthBytes + 4);
    header[0] = 128 | opcode;
    if (length < 126) {
      header[1] = 128 | length;
    } else if (length <= 65535) {
      header[1] = 128 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 128 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const maskOffset = 2 + lengthBytes;
    const mask = randomBytes(4);
    mask.copy(header, maskOffset);
    const masked = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    socket.write(Buffer.concat([header, masked]));
  }
  handleWebSocketData(chunk) {
    let frames;
    try {
      frames = this.wsDecoder.push(chunk);
    } catch (error) {
      this.emit("protocolError", asError(error));
      this.socket?.destroy(asError(error));
      return;
    }
    for (const { opcode, payload } of frames) {
      if (opcode === 1) {
        this.handleLine(payload.toString("utf8"));
      } else if (opcode === 8) {
        this.socket?.end();
      } else if (opcode === 9) {
        this.writeWebSocketFrame(10, payload);
      }
    }
  }
  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      this.emit("protocolError", asError(error));
      return;
    }
    if (message.id !== void 0 && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== void 0) {
      void this.handleServerRequest(message);
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) {
      this.emit("notification", message);
      if (message.method === "error") {
        this.emit("serverError", message.params);
      } else {
        this.emit(message.method, message.params);
      }
    }
  }
  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
  async handleServerRequest(message) {
    try {
      if (process.env.CODEX_INTERCOM_DEBUG_TOOL_CALLS) {
        process.stderr.write(`app-server request ${message.method ?? "unknown"}: ${JSON.stringify(message.params ?? {})}
`);
      }
      this.respond(message.id, await this.options.serverRequestHandler(message));
    } catch (error) {
      if (process.env.CODEX_INTERCOM_DEBUG_TOOL_CALLS) {
        process.stderr.write(`app-server request failed ${message.method ?? "unknown"}: ${asError(error).message}
`);
      }
      this.respondError(message.id, -32601, asError(error).message);
    }
  }
};
function defaultServerRequestResponseFromMessage(message) {
  if (!message.method) throw new Error("Unsupported app-server request");
  return defaultServerRequestResponse(message.method);
}
var WebSocketFrameDecoder = class {
  buffer = Buffer.alloc(0);
  continuationOpcode = null;
  continuationParts = [];
  continuationBytes = 0;
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 128);
      const rsv = first & 112;
      const opcode = first & 15;
      const masked = Boolean(second & 128);
      let length = second & 127;
      let offset = 2;
      if (rsv !== 0) throw new Error("Unsupported WebSocket RSV bits");
      if (length === 126) {
        if (this.buffer.length < offset + 2) break;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) break;
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
        length = Number(bigLength);
        offset += 8;
      }
      const maskOffset = masked ? offset : -1;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) break;
      const mask = masked ? Buffer.from(this.buffer.subarray(maskOffset, maskOffset + 4)) : null;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.acceptFrame(frames, opcode, fin, payload);
    }
    return frames;
  }
  acceptFrame(frames, opcode, fin, payload) {
    if (opcode >= 8) {
      if (!fin) throw new Error("Fragmented WebSocket control frame");
      if (payload.length > 125) throw new Error("Oversized WebSocket control frame");
      frames.push({ opcode, payload });
      return;
    }
    if (opcode === 0) {
      if (this.continuationOpcode === null) throw new Error("Unexpected WebSocket continuation frame");
      this.appendContinuation(payload);
      if (fin) {
        frames.push({ opcode: this.continuationOpcode, payload: Buffer.concat(this.continuationParts, this.continuationBytes) });
        this.clearContinuation();
      }
      return;
    }
    if (opcode !== 1 && opcode !== 2) throw new Error(`Unsupported WebSocket opcode: ${opcode}`);
    if (this.continuationOpcode !== null) throw new Error("New WebSocket data frame before continuation completed");
    if (fin) {
      frames.push({ opcode, payload });
      return;
    }
    this.continuationOpcode = opcode;
    this.continuationParts = [];
    this.continuationBytes = 0;
    this.appendContinuation(payload);
  }
  appendContinuation(payload) {
    this.continuationBytes += payload.length;
    if (this.continuationBytes > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error("WebSocket message too large");
    this.continuationParts.push(payload);
  }
  clearContinuation() {
    this.continuationOpcode = null;
    this.continuationParts = [];
    this.continuationBytes = 0;
  }
};

// codex/bridge-config.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { dirname, join as join2, parse as parsePath, resolve as resolve2 } from "node:path";
import { cwd as processCwd } from "node:process";
import { types as nodeUtilTypes2 } from "node:util";

// broker/paths.ts
import { chmodSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";
var INTERCOM_DIR_MODE = 448;
var INTERCOM_RUNTIME_FILE_MODE = 384;
var INTERCOM_TCP_HOST = "127.0.0.1";
var INTERCOM_PROTOCOL_NAME = "pi-intercom";
var INTERCOM_PROTOCOL_VERSION = 4;
function sanitizePipeSegment(value) {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}
function getAgentDirPath(env = process.env, homeDir = homedir(), cwd = process.cwd()) {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return join(homeDir, ".pi/agent");
  }
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
function getIntercomDirPath(agentDir = getAgentDirPath()) {
  return join(agentDir, "intercom");
}
function shouldUseWindowsTcpTransport(platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return false;
  }
  const transport = env.PI_INTERCOM_TRANSPORT?.trim().toLowerCase();
  if (transport === "tcp") {
    return true;
  }
  const legacyOptIn = env.PI_INTERCOM_TCP?.trim().toLowerCase();
  return legacyOptIn === "1" || legacyOptIn === "true";
}
function getBrokerPortFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker.port.json");
}
function getBrokerSocketPath(platform = process.platform, agentDir = getAgentDirPath()) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }
  return join(getIntercomDirPath(agentDir), "broker.sock");
}
function getBrokerConnectTarget(platform = process.platform, env = process.env, intercomDir = getIntercomDirPath(getAgentDirPath(env))) {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    const endpointFile = getBrokerPortFilePath(intercomDir);
    const raw = readFileSync(endpointFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}: expected a JSON object`);
    }
    const endpoint = parsed;
    if (endpoint.transport !== "tcp" || endpoint.host !== INTERCOM_TCP_HOST || typeof endpoint.port !== "number" || !Number.isSafeInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535 || typeof endpoint.stateId !== "string" || endpoint.stateId.length === 0) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}`);
    }
    return { transport: "tcp", host: endpoint.host, port: endpoint.port, stateId: endpoint.stateId };
  }
  return getBrokerSocketPath(platform, getAgentDirPath(env));
}
function ensureIntercomRuntimeDir(intercomDir = getIntercomDirPath(), platform = process.platform) {
  mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (platform !== "win32") {
    chmodSync(intercomDir, INTERCOM_DIR_MODE);
  }
}
function restrictIntercomRuntimeFile(filePath, platform = process.platform) {
  if (platform !== "win32") {
    chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
  }
}

// broker/boss-adapter.ts
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_CONTROL_ENVELOPE_VERSION,
  BOSS_POLICY_PRINCIPAL_VERSION,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE,
  BOSS_RUN_FEATURE_CONTRACT,
  BOSS_RUN_FEATURE_SEMANTICS_HASH,
  BOSS_RUN_FEATURE_VERSION,
  BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
  BROKER_FEATURE_ATTESTATION_VERSION,
  INTERCOM_BASE_PROTOCOL_VERSION,
  authorizeFeatureAware,
  brokerFeatureSetHash,
  parseBossControlEnvelope,
  parseBossParticipantBinding,
  parseBossParticipantCredentialEnvelope,
  parseBossRunFeatureContract,
  parseBrokerCapabilityAdvertisement,
  parseParticipantState,
  parseWorkerIdentityV2
} from "@ctliz/agent-intercom-core/boss";
import {
  ContractValidationError,
  assertExactKeys,
  assertRecord,
  canonicalJson
} from "@ctliz/agent-intercom-core/canonical";
import { types as nodeUtilTypes } from "node:util";
var BOSS_ADVERTISEMENT_PREDICATES = [
  "protectedProvider",
  "brokerIdentity",
  "credentialRegistry",
  "authorityTransitions",
  "participantHealth"
];
var DORMANT_BOSS_ADVERTISEMENT_READINESS = Object.freeze({
  protectedProvider: false,
  brokerIdentity: false,
  credentialRegistry: false,
  authorityTransitions: false,
  participantHealth: false
});
var ORDINARY_SESSION_REGISTRATION_KEYS = [
  "cwd",
  "model",
  "pid",
  "startedAt",
  "lastActivity"
];
var OPTIONAL_SESSION_REGISTRATION_KEYS = ["name", "status", "runtimeInstanceId"];
function assertBossCanonicalData(value, path = "$", seen = /* @__PURE__ */ new WeakSet()) {
  if (typeof value !== "object" || value === null) return;
  if (nodeUtilTypes.isProxy(value)) {
    throw new ContractValidationError(path, "proxies are not supported");
  }
  if (seen.has(value)) throw new ContractValidationError(path, "cyclic values are not supported");
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new ContractValidationError(path, "must use the exact Array prototype");
    }
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = /* @__PURE__ */ new Set(["length"]);
    for (let index = 0; index < value.length; index += 1) expectedKeys.add(String(index));
    if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key))) {
      throw new ContractValidationError(path, "must be a dense array without symbols or extra properties");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new ContractValidationError(`${path}[${index}]`, "sparse array holes are not supported");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === void 0 || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new ContractValidationError(`${path}[${index}]`, "must be an own enumerable data property");
      }
      assertBossCanonicalData(descriptor.value, `${path}[${index}]`, seen);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ContractValidationError(path, "must use the exact Object prototype");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new ContractValidationError(path, "symbol properties are not supported");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === void 0 || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new ContractValidationError(`${path}.${key}`, "must be an own enumerable data property");
    }
    assertBossCanonicalData(descriptor.value, `${path}.${key}`, seen);
  }
}
function parseBossAdvertisementReadiness(value) {
  assertBossCanonicalData(value, "$.readiness");
  assertRecord(value);
  assertExactKeys(value, BOSS_ADVERTISEMENT_PREDICATES);
  const parsed = {};
  for (const predicate of BOSS_ADVERTISEMENT_PREDICATES) {
    const enabled = ownDataValue(value, predicate);
    if (typeof enabled !== "boolean") {
      throw new ContractValidationError(`$.readiness.${predicate}`, "must be a boolean");
    }
    parsed[predicate] = enabled;
  }
  return parsed;
}
function missingBossAdvertisementPredicates(readiness = DORMANT_BOSS_ADVERTISEMENT_READINESS) {
  const parsed = parseBossAdvertisementReadiness(readiness);
  return BOSS_ADVERTISEMENT_PREDICATES.filter((predicate) => parsed[predicate] !== true);
}
function bossCapabilityAdvertisement(readiness = DORMANT_BOSS_ADVERTISEMENT_READINESS) {
  if (missingBossAdvertisementPredicates(readiness).length > 0) return void 0;
  const features = [{
    version: BROKER_FEATURE_ATTESTATION_VERSION,
    feature: BOSS_RUN_FEATURE,
    featureVersion: BOSS_RUN_FEATURE_VERSION,
    semanticsHash: BOSS_RUN_FEATURE_SEMANTICS_HASH,
    controlEnvelopeVersion: BOSS_CONTROL_ENVELOPE_VERSION,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST
  }];
  return parseBrokerCapabilityAdvertisement({
    baseProtocolVersion: INTERCOM_BASE_PROTOCOL_VERSION,
    features,
    protocolFeatureContractHash: BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
    featureSetHash: brokerFeatureSetHash(features),
    controlEnvelopeVersion: BOSS_CONTROL_ENVELOPE_VERSION,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST
  });
}
function optionalOwnDataValue(value, key) {
  assertRecord(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === void 0) return void 0;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new ContractValidationError(`$.${key}`, "must be an own enumerable data property");
  }
  return descriptor.value;
}
function ownDataValue(value, key) {
  const result = optionalOwnDataValue(value, key);
  if (result === void 0) throw new ContractValidationError(`$.${key}`, "is required");
  return result;
}
function parseBossParticipantRegistrationMetadata(value) {
  assertBossCanonicalData(value);
  assertRecord(value);
  assertExactKeys(value, ["featureContract", "credential"]);
  const featureContract = parseBossRunFeatureContract(ownDataValue(value, "featureContract"));
  if (featureContract.baseProtocolVersion !== INTERCOM_BASE_PROTOCOL_VERSION || canonicalJson(featureContract) !== canonicalJson(BOSS_RUN_FEATURE_CONTRACT)) {
    throw new ContractValidationError("$.featureContract", "must exactly negotiate boss-run-v1 over base protocol v3");
  }
  const credential = parseBossParticipantCredentialEnvelope(ownDataValue(value, "credential"));
  if (credential.namespace !== featureContract.feature) {
    throw new ContractValidationError("$.credential.namespace", "must match the negotiated feature namespace");
  }
  return { featureContract, credential };
}
function exactRegistrationKind(session, value) {
  assertBossCanonicalData(session, "$.session");
  assertRecord(session);
  const boss = optionalOwnDataValue(session, "boss");
  if (boss === void 0) {
    if (value === void 0) return "ordinary";
    throw new ContractValidationError("$.registrationKind", "must be absent when Boss metadata is absent");
  }
  if (value !== "boss") {
    throw new ContractValidationError("$.registrationKind", "must be boss when Boss metadata is present");
  }
  return "boss";
}
function parseExactRegistrationFrame(value) {
  assertBossCanonicalData(value, "$.register");
  assertRecord(value);
  const session = ownDataValue(value, "session");
  assertRecord(session);
  const registrationKind = optionalOwnDataValue(value, "registrationKind");
  const kind = exactRegistrationKind(session, registrationKind);
  if (kind === "ordinary") {
    assertExactKeys(value, ["type", "protocol", "version", "session"], ["sessionId", "stateId", "access", "scopeId"]);
    assertExactKeys(session, ORDINARY_SESSION_REGISTRATION_KEYS, OPTIONAL_SESSION_REGISTRATION_KEYS);
  } else {
    assertExactKeys(value, ["type", "registrationKind", "protocol", "version", "session"], ["sessionId", "stateId", "scopeId"]);
    assertExactKeys(session, [...ORDINARY_SESSION_REGISTRATION_KEYS, "boss"], OPTIONAL_SESSION_REGISTRATION_KEYS);
    parseBossParticipantRegistrationMetadata(ownDataValue(session, "boss"));
  }
  if (ownDataValue(value, "type") !== "register") {
    throw new ContractValidationError("$.register.type", "must be register");
  }
  return value;
}
function parseExactRegisteredFrame(value, expected) {
  assertBossCanonicalData(value, "$.registered");
  assertRecord(value);
  if (expected === "boss") {
    assertExactKeys(value, ["type", "registrationKind", "sessionId", "protocol", "version", "capabilities", "boss"]);
    if (ownDataValue(value, "registrationKind") !== "boss") {
      throw new ContractValidationError("$.registered.registrationKind", "must be boss");
    }
    const sessionId = ownDataValue(value, "sessionId");
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ContractValidationError("$.registered.sessionId", "must be a non-empty string");
    }
    const advertisement = parseBrokerCapabilityAdvertisement(ownDataValue(value, "capabilities"));
    const expectedAdvertisement = bossCapabilityAdvertisement({
      protectedProvider: true,
      brokerIdentity: true,
      credentialRegistry: true,
      authorityTransitions: true,
      participantHealth: true
    });
    const bossFeature = advertisement.features.find((feature) => feature.feature === BOSS_RUN_FEATURE);
    if (bossFeature === void 0 || canonicalJson(bossFeature) !== canonicalJson(expectedAdvertisement.features[0]) || advertisement.baseProtocolVersion !== expectedAdvertisement.baseProtocolVersion || advertisement.protocolFeatureContractHash !== expectedAdvertisement.protocolFeatureContractHash || advertisement.controlEnvelopeVersion !== expectedAdvertisement.controlEnvelopeVersion || advertisement.capabilityDigest !== expectedAdvertisement.capabilityDigest) throw new ContractValidationError("$.registered.capabilities", "must exactly echo the requested boss-run-v1 contract");
    parseBossParticipantBindingMetadata(ownDataValue(value, "boss"), sessionId);
  } else if (expected === "ordinary-remote") {
    assertExactKeys(value, ["type", "sessionId", "protocol", "version", "remoteAccess", "access"]);
  } else {
    assertExactKeys(value, ["type", "sessionId", "protocol", "version"]);
  }
  if (ownDataValue(value, "type") !== "registered") {
    throw new ContractValidationError("$.registered.type", "must be registered");
  }
  return value;
}
function parseBossParticipantBindingMetadata(value, expectedSessionId) {
  assertBossCanonicalData(value);
  assertRecord(value);
  assertExactKeys(
    value,
    ["featureContract", "binding", "brokerIdentityVerified"],
    ["assignedParticipantIds", "requestingPrincipalId", "workerIdentity", "participantState"]
  );
  const featureContract = parseBossRunFeatureContract(ownDataValue(value, "featureContract"));
  if (featureContract.baseProtocolVersion !== INTERCOM_BASE_PROTOCOL_VERSION || canonicalJson(featureContract) !== canonicalJson(BOSS_RUN_FEATURE_CONTRACT)) {
    throw new ContractValidationError("$.featureContract", "must exactly bind boss-run-v1 over base protocol v3");
  }
  const binding = parseBossParticipantBinding(ownDataValue(value, "binding"));
  if (ownDataValue(value, "brokerIdentityVerified") !== true) {
    throw new ContractValidationError("$.brokerIdentityVerified", "must be true for a broker-owned Boss binding");
  }
  if (expectedSessionId !== void 0 && binding.sessionId !== expectedSessionId) {
    throw new ContractValidationError("$.binding.sessionId", "must match the registered intercom session");
  }
  const rawAssignedParticipantIds = optionalOwnDataValue(value, "assignedParticipantIds");
  let assignedParticipantIds;
  if (rawAssignedParticipantIds !== void 0) {
    if (binding.role !== "manager" || !Array.isArray(rawAssignedParticipantIds) || rawAssignedParticipantIds.some((entry) => typeof entry !== "string" || entry.length === 0) || new Set(rawAssignedParticipantIds).size !== rawAssignedParticipantIds.length) {
      throw new ContractValidationError("$.assignedParticipantIds", "must be a unique participant list present only for a Manager");
    }
    assignedParticipantIds = rawAssignedParticipantIds;
  }
  if (binding.role === "manager" && assignedParticipantIds === void 0) {
    throw new ContractValidationError("$.assignedParticipantIds", "is required for a Manager policy binding");
  }
  const rawRequestingPrincipalId = optionalOwnDataValue(value, "requestingPrincipalId");
  if (binding.role === "council" !== (typeof rawRequestingPrincipalId === "string" && rawRequestingPrincipalId.length > 0)) {
    throw new ContractValidationError("$.requestingPrincipalId", "is required exactly for a Council policy binding");
  }
  const requestingPrincipalId = typeof rawRequestingPrincipalId === "string" ? rawRequestingPrincipalId : void 0;
  const rawWorkerIdentity = optionalOwnDataValue(value, "workerIdentity");
  const rawParticipantState = optionalOwnDataValue(value, "participantState");
  if (rawWorkerIdentity === void 0 !== (rawParticipantState === void 0)) {
    throw new ContractValidationError("$.workerIdentity", "workerIdentity and participantState must be supplied together");
  }
  const workerIdentity = rawWorkerIdentity === void 0 ? void 0 : parseWorkerIdentityV2(rawWorkerIdentity);
  const participantState = rawParticipantState === void 0 ? void 0 : parseParticipantState(rawParticipantState, "$.participantState");
  if (workerIdentity !== void 0 && (!("bossRunId" in workerIdentity) || workerIdentity.bossRunId !== binding.bossRunId || workerIdentity.participantId !== binding.participantId || workerIdentity.bindingEpoch !== binding.bindingEpoch)) throw new ContractValidationError("$.workerIdentity", "must match the broker-owned participant binding");
  return {
    featureContract,
    binding,
    brokerIdentityVerified: true,
    ...assignedParticipantIds === void 0 ? {} : { assignedParticipantIds: [...assignedParticipantIds] },
    ...requestingPrincipalId === void 0 ? {} : { requestingPrincipalId },
    ...workerIdentity === void 0 ? {} : { workerIdentity, participantState }
  };
}
var BOSS_CONTROL_KIND_BY_TYPE = {
  "boss.assignment.created": "assignment_request",
  "boss.assignment.accepted": "assignment_response",
  "boss.assignment.checkpoint": "assignment_response",
  "boss.assignment.submitted": "assignment_response",
  "boss.assignment.rejected": "assignment_response",
  "boss.assignment.cancelled": "lifecycle",
  "boss.staffing.requested": "staffing",
  "boss.staffing.resolved": "staffing",
  "boss.review.requested": "review_request",
  "boss.review.submitted": "review_result",
  "boss.council.requested": "review_request",
  "boss.council.submitted": "review_result",
  "boss.proof.submitted": "proof",
  "boss.worker.health": "health",
  "boss.worker.blocked": "health",
  "boss.worker.failed": "health",
  "boss.worker.notice": "lifecycle",
  "boss.worker.notice_delivery_failed": "lifecycle",
  "boss.decision.required": "decision"
};
function bossControlKind(envelopeValue) {
  assertBossCanonicalData(envelopeValue);
  const envelope = parseBossControlEnvelope(envelopeValue);
  return { envelope, controlKind: BOSS_CONTROL_KIND_BY_TYPE[envelope.type] };
}

// codex/bridge-config.ts
var DEFAULT_BRIDGE_CONFIG_PATH = join2(getIntercomDirPath(), "codex-bridge.json");
var DEFAULT_BRIDGE_STATE_PATH = join2(getIntercomDirPath(), "codex-bridge-state.json");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !nodeUtilTypes2.isProxy(value);
}
function optionalString(value, field) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || void 0;
}
function requireString(value, field) {
  const result = optionalString(value, field);
  if (!result) throw new Error(`${field} must be a non-empty string`);
  return result;
}
function parseHardenedBossClientKind(value, field) {
  if (value === void 0 || value === null) return void 0;
  if (value === "boss_participant" || value === "boss_reviewer") return value;
  throw new Error(`${field} must be boss_participant or boss_reviewer`);
}
function sandboxType(value) {
  if (!isRecord(value)) return void 0;
  return typeof value.type === "string" ? value.type : void 0;
}
function assertHardenedBossAgentConfig(agent) {
  if (nodeUtilTypes2.isProxy(agent)) throw new Error("Hardened Boss agent config must not be a proxy");
  assertBossCanonicalData(agent, "$.agent");
  if (agent.bossClient === void 0) return;
  if (agent.sandboxPolicy !== void 0 && !isRecord(agent.sandboxPolicy)) {
    throw new Error(`${agent.bossClient} sandboxPolicy must be a plain object`);
  }
  if (agent.approvalPolicy !== void 0 && typeof agent.approvalPolicy !== "string") {
    throw new Error(`${agent.bossClient} approvalPolicy must be a string`);
  }
  const type = sandboxType(agent.sandboxPolicy);
  if (type === "dangerFullAccess" || type === "danger-full-access") {
    throw new Error(`${agent.bossClient} cannot use danger-full-access`);
  }
  if (agent.approvalPolicy === "never") {
    throw new Error(`${agent.bossClient} cannot disable approval checks`);
  }
  if (agent.bossClient === "boss_reviewer" && type !== void 0 && type !== "readOnly" && type !== "read-only") {
    throw new Error("boss_reviewer must use a read-only sandbox");
  }
  const canonicalCwd = resolve2(agent.cwd);
  if (agent.bossClient === "boss_participant" && canonicalCwd === parsePath(canonicalCwd).root) {
    throw new Error("boss_participant workspace root must not be a filesystem root");
  }
  if (isRecord(agent.sandboxPolicy)) {
    assertBossCanonicalData(agent.sandboxPolicy, "$.agent.sandboxPolicy");
    const allowedKeys = type === "workspaceWrite" || type === "workspace-write" ? /* @__PURE__ */ new Set(["type", "writableRoots", "networkAccess"]) : /* @__PURE__ */ new Set(["type", "networkAccess"]);
    const keys = Reflect.ownKeys(agent.sandboxPolicy);
    if (keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      throw new Error(`${agent.bossClient} sandboxPolicy contains unsupported capability fields`);
    }
    if (agent.sandboxPolicy.networkAccess !== false) {
      throw new Error(`${agent.bossClient} networkAccess must be false`);
    }
    if (type !== "readOnly" && type !== "read-only" && type !== "workspaceWrite" && type !== "workspace-write") {
      throw new Error(`${agent.bossClient} sandboxPolicy type is unsupported`);
    }
  }
  if (isRecord(agent.sandboxPolicy) && (type === "workspaceWrite" || type === "workspace-write")) {
    const roots = agent.sandboxPolicy.writableRoots;
    assertBossCanonicalData(roots, "$.agent.sandboxPolicy.writableRoots");
    if (!Array.isArray(roots) || nodeUtilTypes2.isProxy(roots) || roots.some((root) => typeof root !== "string")) {
      throw new Error(`${agent.bossClient} writableRoots must be a dense string array`);
    }
    if (agent.bossClient === "boss_reviewer" || roots.length !== 1 || resolve2(roots[0]) !== canonicalCwd) {
      throw new Error(`${agent.bossClient} writable roots must be restricted to the agent cwd`);
    }
  }
  if (agent.bossClient === "boss_participant") {
    throw new Error("boss_participant requires unavailable broker-owned assigned workspace authority");
  }
}
function bridgeAgentApprovalPolicy(agent) {
  return agent.approvalPolicy ?? (agent.bossClient === void 0 ? "never" : HARDENED_BOSS_CODEX_DEFAULTS[agent.bossClient].approvalPolicy);
}
function bridgeAgentDefaultSandbox(agent) {
  return agent.bossClient === void 0 ? void 0 : HARDENED_BOSS_CODEX_DEFAULTS[agent.bossClient].sandbox;
}
function assertHardenedBossBridgeConfig(config) {
  assertBossCanonicalData(config, "$.bridgeConfig");
  if (nodeUtilTypes2.isProxy(config) || nodeUtilTypes2.isProxy(config.agents) || !Array.isArray(config.agents)) {
    throw new Error("Bridge config and agents must be plain non-proxy data");
  }
  for (let index = 0; index < config.agents.length; index += 1) {
    if (!Object.hasOwn(config.agents, index)) throw new Error("Bridge agents must not be sparse");
    const agent = config.agents[index];
    if (typeof agent !== "object" || agent === null || Array.isArray(agent) || nodeUtilTypes2.isProxy(agent)) {
      throw new Error("Bridge agents must be plain non-proxy objects");
    }
  }
  if (!config.agents.some((agent) => agent.bossClient !== void 0)) return;
  if (config.appServer !== void 0) {
    assertBossCanonicalData(config.appServer, "$.appServer");
    if (nodeUtilTypes2.isProxy(config.appServer)) throw new Error("Hardened Boss app-server config must not be a proxy");
    if (config.appServer.command !== void 0 || config.appServer.startDaemonCommand !== void 0) {
      throw new Error("Hardened Boss bridge cannot use caller-provided app-server commands");
    }
  }
  for (const args of [config.appServer?.args, config.appServer?.startDaemonArgs]) {
    if (!args) continue;
    assertBossCanonicalData(args, "$.appServer.argv");
    if (nodeUtilTypes2.isProxy(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Hardened Boss bridge arguments must be dense string arrays");
    for (const arg of args) {
      if (arg === "--") {
        continue;
      }
      if (arg.length > 2 && arg.startsWith("-C")) {
        throw new Error("Hardened Boss bridge cannot pass launch escape -C to app-server");
      }
      const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (["-c", "--config", "-p", "--profile", "--enable", "--disable"].includes(optionName) || optionName.startsWith("-c") && optionName !== "-C" || optionName.startsWith("-p")) {
        throw new Error(`Hardened Boss bridge cannot pass raw ${optionName} or profile configuration to app-server`);
      }
      if (["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--yolo", "--add-dir", "--cd", "-C"].includes(optionName)) {
        throw new Error(`Hardened Boss bridge cannot pass launch escape ${optionName} to app-server`);
      }
      if (["--sandbox", "--ask-for-approval"].includes(optionName) || optionName === "-s" || optionName === "-a" || optionName.startsWith("-s") || optionName.startsWith("-a")) {
        throw new Error(`Hardened Boss bridge cannot pass policy override ${optionName} to app-server`);
      }
      if (optionName.startsWith("-") && /(?:yolo|danger|bypass)/i.test(optionName)) {
        throw new Error(`Hardened Boss bridge cannot pass launch escape ${optionName} to app-server`);
      }
    }
  }
  for (const agent of config.agents) assertHardenedBossAgentConfig(agent);
}
function normalizeAgent(raw, index) {
  if (!isRecord(raw)) throw new Error(`agents[${index}] must be an object`);
  const id = requireString(raw.id, `agents[${index}].id`);
  const name = optionalString(raw.name, `agents[${index}].name`) ?? id;
  const agent = {
    id,
    name,
    cwd: resolve2(optionalString(raw.cwd, `agents[${index}].cwd`) ?? processCwd()),
    model: optionalString(raw.model, `agents[${index}].model`),
    threadId: optionalString(raw.threadId, `agents[${index}].threadId`),
    instructions: optionalString(raw.instructions, `agents[${index}].instructions`),
    approvalPolicy: raw.approvalPolicy,
    sandboxPolicy: raw.sandboxPolicy,
    bossClient: parseHardenedBossClientKind(raw.bossClient, `agents[${index}].bossClient`)
  };
  assertHardenedBossAgentConfig(agent);
  return agent;
}
function defaultBridgeConfig(env = process.env) {
  const id = env.CODEX_INTERCOM_BRIDGE_ID?.trim() || "codex-worker";
  const bossClient = parseHardenedBossClientKind(env.CODEX_INTERCOM_BOSS_CLIENT?.trim(), "CODEX_INTERCOM_BOSS_CLIENT");
  const agent = {
    id,
    name: env.CODEX_INTERCOM_BRIDGE_NAME?.trim() || id,
    cwd: resolve2(env.CODEX_INTERCOM_BRIDGE_CWD?.trim() || processCwd()),
    model: env.CODEX_INTERCOM_BRIDGE_MODEL?.trim() || void 0,
    instructions: env.CODEX_INTERCOM_BRIDGE_INSTRUCTIONS?.trim() || void 0,
    ...bossClient === void 0 ? {} : { bossClient }
  };
  assertHardenedBossAgentConfig(agent);
  return {
    statePath: env.CODEX_INTERCOM_BRIDGE_STATE?.trim() || DEFAULT_BRIDGE_STATE_PATH,
    agents: [agent]
  };
}
function loadBridgeConfig(path = process.env.CODEX_INTERCOM_BRIDGE_CONFIG || DEFAULT_BRIDGE_CONFIG_PATH) {
  if (!existsSync(path)) return defaultBridgeConfig();
  const parsed = JSON.parse(readFileSync2(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Bridge config must be a JSON object");
  if (!Array.isArray(parsed.agents)) throw new Error("Bridge config requires an agents array");
  const appServer = isRecord(parsed.appServer) ? {
    command: optionalString(parsed.appServer.command, "appServer.command"),
    args: Array.isArray(parsed.appServer.args) ? parsed.appServer.args.map((arg, index) => requireString(arg, `appServer.args[${index}]`)) : void 0,
    transport: parsed.appServer.transport === "unix-websocket" || parsed.appServer.transport === "stdio" ? parsed.appServer.transport : void 0,
    socketPath: optionalString(parsed.appServer.socketPath, "appServer.socketPath"),
    startDaemon: typeof parsed.appServer.startDaemon === "boolean" ? parsed.appServer.startDaemon : void 0,
    startDaemonCommand: optionalString(parsed.appServer.startDaemonCommand, "appServer.startDaemonCommand"),
    startDaemonArgs: Array.isArray(parsed.appServer.startDaemonArgs) ? parsed.appServer.startDaemonArgs.map((arg, index) => requireString(arg, `appServer.startDaemonArgs[${index}]`)) : void 0
  } : void 0;
  return {
    statePath: resolve2(optionalString(parsed.statePath, "statePath") ?? DEFAULT_BRIDGE_STATE_PATH),
    agents: parsed.agents.map(normalizeAgent),
    ...appServer ? { appServer } : {}
  };
}
function loadBridgeState(path) {
  if (!existsSync(path)) return { agents: {} };
  const parsed = JSON.parse(readFileSync2(path, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.agents)) return { agents: {} };
  const agents = {};
  for (const [id, value] of Object.entries(parsed.agents)) {
    if (!isRecord(value) || typeof value.threadId !== "string") continue;
    agents[id] = {
      threadId: value.threadId,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0
    };
  }
  return { agents };
}
function saveBridgeState(path, state) {
  mkdirSync2(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}
`, { mode: 384 });
  restrictIntercomRuntimeFile(path);
}

// broker/client.ts
import { EventEmitter as EventEmitter2 } from "events";
import net2 from "net";
import { randomUUID as randomUUID2 } from "crypto";
import { POLICY_SEMANTICS_HASH, POLICY_SEMANTICS_VERSION } from "@ctliz/agent-intercom-core";
import {
  BOSS_RUN_FEATURE as BOSS_RUN_FEATURE2,
  parseBrokerCapabilityAdvertisement as parseBrokerCapabilityAdvertisement2
} from "@ctliz/agent-intercom-core/boss";

// broker/framing.ts
var MAX_FRAME_BYTES = 1024 * 1024;
function writeMessage(socket, msg) {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}
function createMessageReader(onMessage, onError, maxFrameBytes = MAX_FRAME_BYTES) {
  let buffer = Buffer.alloc(0);
  function reportMessage(payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf-8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
      return false;
    }
    try {
      onMessage(msg);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
      return false;
    }
  }
  return (data) => {
    let remaining = data;
    while (remaining.length > 0) {
      if (buffer.length < 4) {
        const headerBytes = Math.min(4 - buffer.length, remaining.length);
        buffer = Buffer.concat([buffer, remaining.subarray(0, headerBytes)]);
        remaining = remaining.subarray(headerBytes);
        if (buffer.length < 4) {
          return;
        }
      }
      const length = buffer.readUInt32BE(0);
      if (length > maxFrameBytes) {
        buffer = Buffer.alloc(0);
        onError(new Error(`Intercom frame length ${length} exceeds maximum ${maxFrameBytes} bytes`));
        return;
      }
      const missingPayloadBytes = length - Math.max(0, buffer.length - 4);
      const payloadBytes = Math.min(missingPayloadBytes, remaining.length);
      if (payloadBytes > 0) {
        buffer = Buffer.concat([buffer, remaining.subarray(0, payloadBytes)]);
        remaining = remaining.subarray(payloadBytes);
      }
      if (buffer.length < 4 + length) {
        return;
      }
      const payload = buffer.subarray(4, 4 + length);
      buffer = Buffer.alloc(0);
      if (!reportMessage(payload)) {
        return;
      }
    }
  };
}

// protocol-v4/contract.ts
import {
  INTERCOM_PROTOCOL_NAME as INTERCOM_PROTOCOL_NAME2,
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  INTERCOM_PROTOCOL_V4_VECTORS,
  INTERCOM_PROTOCOL_VERSION as INTERCOM_PROTOCOL_VERSION2,
  INTERCOM_SCOPE_ENV,
  INTERCOM_SCOPE_ID_PATTERN,
  INTERCOM_SCOPE_ID_PATTERN_SOURCE,
  intercomScopeIdFromEnv,
  parseIntercomScopeId,
  sameIntercomScope
} from "@ctliz/agent-intercom-core/protocol-v4";

// outbound-outbox.ts
import { createHash as createHash2 } from "crypto";
import { chmodSync as chmodSync2, existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync2 } from "fs";
import { join as join3 } from "path";

// durable-json.ts
import { randomUUID } from "crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname2 } from "path";
function writeDurableJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync2(temporaryPath, JSON.stringify(value), { encoding: "utf-8", mode: INTERCOM_RUNTIME_FILE_MODE });
  const fileDescriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(temporaryPath, filePath);
  restrictIntercomRuntimeFile(filePath);
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(dirname2(filePath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

// outbound-outbox.ts
var OUTBOX_STATE_VERSION = 1;
var MAX_OUTBOX_MESSAGES = 256;
function fingerprint(entry) {
  return JSON.stringify({
    to: entry.to,
    replyTo: entry.message.replyTo,
    expectsReply: entry.message.expectsReply,
    content: entry.message.content
  });
}
function isStoredOutboundMessage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value;
  if (typeof entry.to !== "string" || typeof entry.queuedAt !== "number") return false;
  if (typeof entry.message !== "object" || entry.message === null || Array.isArray(entry.message)) return false;
  const message = entry.message;
  return typeof message.id === "string" && typeof message.timestamp === "number" && typeof message.content === "object" && message.content !== null && typeof message.content.text === "string";
}
function fileName(sessionId) {
  return `${createHash2("sha256").update(sessionId).digest("hex")}.json`;
}
var PersistentOutboundOutbox = class {
  directory;
  filePath;
  state;
  constructor(sessionId, intercomDir = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    this.directory = join3(intercomDir, "outbox");
    mkdirSync3(this.directory, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync2(this.directory, INTERCOM_DIR_MODE);
    this.filePath = join3(this.directory, fileName(sessionId));
    this.state = this.load();
  }
  list() {
    return this.state.entries.map((entry) => ({ ...entry, message: { ...entry.message, content: { ...entry.message.content } } }));
  }
  enqueue(to, message) {
    const existing = this.state.entries.find((entry) => entry.message.id === message.id);
    if (existing) {
      if (fingerprint(existing) !== fingerprint({ to, message })) {
        throw new Error(`Message ID ${message.id} is already queued with a different payload`);
      }
      return "existing";
    }
    if (this.state.entries.length >= MAX_OUTBOX_MESSAGES) {
      throw new Error(`Durable outbox is full (${MAX_OUTBOX_MESSAGES} messages)`);
    }
    this.state.entries.push({ to, message, queuedAt: Date.now() });
    this.persist();
    return "added";
  }
  remove(messageId) {
    const remaining = this.state.entries.filter((entry) => entry.message.id !== messageId);
    if (remaining.length === this.state.entries.length) return;
    this.state.entries = remaining;
    this.persist();
  }
  clear() {
    if (this.state.entries.length === 0) return;
    this.state.entries = [];
    this.persist();
  }
  load() {
    if (!existsSync2(this.filePath)) return { version: OUTBOX_STATE_VERSION, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync3(this.filePath, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed;
      if (state.version !== OUTBOX_STATE_VERSION || !Array.isArray(state.entries) || !state.entries.every(isStoredOutboundMessage)) {
        throw new Error("invalid outbox state");
      }
      return { version: OUTBOX_STATE_VERSION, entries: state.entries };
    } catch {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync2(this.filePath, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      return { version: OUTBOX_STATE_VERSION, entries: [] };
    }
  }
  persist() {
    writeDurableJson(this.filePath, this.state);
  }
};

// boss-control-outbox.ts
import { createHash as createHash3 } from "node:crypto";
import { chmodSync as chmodSync3, existsSync as existsSync3, mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync as renameSync3 } from "node:fs";
import { join as join4 } from "node:path";
import { canonicalHash } from "@ctliz/agent-intercom-core/canonical";
import { parseBossControlEnvelope as parseBossControlEnvelope2 } from "@ctliz/agent-intercom-core/boss";
var BOSS_CONTROL_OUTBOX_VERSION = 2;
var MAX_BOSS_CONTROL_OUTBOX_ENTRIES = 256;
function scope(envelope) {
  return canonicalHash("agent-intercom-codex/boss-control/outbox-scope/v1", {
    bossRunId: envelope.bossRunId,
    participantId: envelope.participantId,
    bindingEpoch: Number(envelope.bindingEpoch),
    idempotencyKey: envelope.idempotencyKey
  });
}
function fingerprint2(to, envelope) {
  const { messageId: _transportMessageId, ...stableEnvelope } = envelope;
  return canonicalHash("agent-intercom-codex/boss-control/outbox-request/v1", { to, envelope: stableEnvelope });
}
function exactKeys(value, required, optional = []) {
  const permitted = /* @__PURE__ */ new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => typeof key === "string" && permitted.has(key));
}
function parseEntry(value) {
  assertBossCanonicalData(value, "$.bossControlOutbox.entries[]");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Boss outbox entry");
  const entry = value;
  if (!exactKeys(entry, ["to", "envelope", "scope", "fingerprint", "queuedAt", "state"], ["deliveryId"])) {
    throw new Error("Invalid Boss outbox entry fields");
  }
  if (typeof entry.to !== "string" || entry.to.length === 0 || typeof entry.scope !== "string" || !/^[a-f0-9]{64}$/.test(entry.scope) || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || typeof entry.queuedAt !== "number" || !Number.isSafeInteger(entry.queuedAt) || entry.state !== "queued" && entry.state !== "accepted" || entry.state === "queued" && Object.hasOwn(entry, "deliveryId") || entry.state === "accepted" && (!Object.hasOwn(entry, "deliveryId") || typeof entry.deliveryId !== "string" || entry.deliveryId.length === 0)) throw new Error("Invalid Boss outbox entry binding");
  const envelope = parseBossControlEnvelope2(entry.envelope);
  if (entry.scope !== scope(envelope) || entry.fingerprint !== fingerprint2(entry.to, envelope)) {
    throw new Error("Boss outbox entry canonical binding mismatch");
  }
  return {
    to: entry.to,
    envelope,
    scope: entry.scope,
    fingerprint: entry.fingerprint,
    queuedAt: entry.queuedAt,
    state: entry.state,
    ...entry.deliveryId === void 0 ? {} : { deliveryId: entry.deliveryId }
  };
}
function fileName2(sessionId) {
  return `${createHash3("sha256").update(sessionId).digest("hex")}.json`;
}
var PersistentBossControlOutbox = class {
  path;
  state;
  constructor(sessionId, intercomDir = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    const directory = join4(intercomDir, "boss-control-outbox");
    mkdirSync4(directory, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync3(directory, INTERCOM_DIR_MODE);
    this.path = join4(directory, fileName2(sessionId));
    this.state = this.load();
  }
  list() {
    return structuredClone(this.state.entries);
  }
  find(idempotencyKey) {
    const entry = this.state.entries.find((candidate) => candidate.envelope.idempotencyKey === idempotencyKey);
    return entry === void 0 ? void 0 : structuredClone(entry);
  }
  enqueue(to, envelopeValue) {
    if (typeof to !== "string" || to.length === 0) throw new Error("Boss target session ID is required");
    assertBossCanonicalData(envelopeValue, "$.envelope");
    const envelope = parseBossControlEnvelope2(envelopeValue);
    const candidateScope = scope(envelope);
    const candidateFingerprint = fingerprint2(to, envelope);
    const existing = this.state.entries.find((entry) => entry.scope === candidateScope);
    if (existing) {
      if (existing.fingerprint !== candidateFingerprint) {
        throw new Error(`Boss idempotency key ${envelope.idempotencyKey} is queued with a different canonical request`);
      }
      if (existing.envelope.messageId !== envelope.messageId) {
        existing.envelope = envelope;
        existing.queuedAt = Date.now();
        this.persist();
      }
      return "existing";
    }
    if (this.state.entries.some((entry) => entry.envelope.messageId === envelope.messageId)) {
      throw new Error(`Boss message ID ${envelope.messageId} is queued with a different idempotency scope`);
    }
    if (this.state.entries.length >= MAX_BOSS_CONTROL_OUTBOX_ENTRIES) throw new Error("Durable Boss control outbox is full");
    this.state.entries.push({
      to,
      envelope,
      scope: candidateScope,
      fingerprint: candidateFingerprint,
      queuedAt: Date.now(),
      state: "queued"
    });
    this.persist();
    return "added";
  }
  markAccepted(idempotencyKey, messageId, deliveryId) {
    const entry = this.state.entries.find((candidate) => candidate.envelope.idempotencyKey === idempotencyKey);
    if (!entry || entry.envelope.messageId !== messageId || !deliveryId) {
      throw new Error("Boss acknowledgement does not match the durable outbox binding");
    }
    if (entry.state === "accepted") {
      if (entry.deliveryId !== deliveryId) throw new Error("Boss acknowledgement changed the durable deliveryId");
      return "already-accepted";
    }
    entry.state = "accepted";
    entry.deliveryId = deliveryId;
    this.persist();
    return "accepted";
  }
  removeCorrelated(idempotencyKey, messageId, deliveryId) {
    const index = this.state.entries.findIndex((candidate) => candidate.envelope.idempotencyKey === idempotencyKey);
    if (index < 0) throw new Error("Boss terminal result has no durable outbox binding");
    const entry = this.state.entries[index];
    if (entry.envelope.messageId !== messageId) throw new Error("Boss terminal result messageId does not match the durable caller");
    if (deliveryId === void 0) {
      if (entry.state !== "queued") throw new Error("Boss post-acceptance failure omitted the durable deliveryId");
    } else if (entry.state !== "accepted" || entry.deliveryId !== deliveryId) {
      throw new Error("Boss terminal result arrived before the matching durable acknowledgement");
    }
    this.state.entries.splice(index, 1);
    this.persist();
  }
  load() {
    if (!existsSync3(this.path)) return { version: BOSS_CONTROL_OUTBOX_VERSION, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync4(this.path, "utf8"));
      assertBossCanonicalData(parsed, "$.bossControlOutbox");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed;
      if (!exactKeys(state, ["version", "entries"]) || state.version !== BOSS_CONTROL_OUTBOX_VERSION || !Array.isArray(state.entries)) {
        throw new Error("invalid Boss outbox state");
      }
      return { version: BOSS_CONTROL_OUTBOX_VERSION, entries: state.entries.map(parseEntry) };
    } catch (error) {
      const corruptPath = `${this.path}.corrupt-${Date.now()}`;
      renameSync3(this.path, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      throw new Error(`Boss control outbox was corrupt and quarantined at ${corruptPath}`, { cause: error });
    }
  }
  persist() {
    writeDurableJson(this.path, this.state);
  }
};

// broker/access-credential.ts
import { readFileSync as readFileSync5 } from "fs";
var ACCESS_CREDENTIAL_ENV = "AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH";
var ACCESS_CREDENTIAL_VERSION = 1;
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
function loadRemoteAccessCredential(env = process.env) {
  const path = env[ACCESS_CREDENTIAL_ENV]?.trim();
  if (!path) return void 0;
  const parsed = JSON.parse(readFileSync5(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Agent Intercom access credential at ${path}`);
  }
  const credential = parsed;
  if (nonEmptyString(credential.enrollmentToken)) {
    return { path, access: { enrollmentToken: credential.enrollmentToken }, enrollment: true };
  }
  if (credential.version === ACCESS_CREDENTIAL_VERSION && nonEmptyString(credential.sessionCredential) && nonEmptyString(credential.sessionId) && typeof credential.generation === "number" && Number.isSafeInteger(credential.generation) && credential.generation > 0) {
    return {
      path,
      access: {
        sessionCredential: credential.sessionCredential,
        sessionId: credential.sessionId,
        generation: credential.generation
      },
      enrollment: false
    };
  }
  throw new Error(`Invalid Agent Intercom access credential at ${path}`);
}
function writeRemoteSessionCredential(path, sessionId, metadata) {
  if (!metadata.sessionCredential) {
    throw new Error("Remote enrollment response omitted the session credential");
  }
  writeDurableJson(path, {
    version: ACCESS_CREDENTIAL_VERSION,
    sessionCredential: metadata.sessionCredential,
    sessionId,
    generation: metadata.generation
  });
}

// broker/boss-control-ledger.ts
import { canonicalJson as canonicalJson2 } from "@ctliz/agent-intercom-core/canonical";
var BOSS_CONTROL_FAILURE_CODES = /* @__PURE__ */ new Set([
  "INVALID_CONTROL",
  "IDEMPOTENCY_CONFLICT",
  "SESSION_NOT_FOUND",
  "POLICY_DENIED",
  "RECIPIENT_DISCONNECTED",
  "DELIVERY_TIMEOUT"
]);
function exactStringKeys(value, required, optional = []) {
  const keys = Reflect.ownKeys(value);
  const permitted = /* @__PURE__ */ new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => typeof key === "string" && permitted.has(key));
}
function parseBossControlResult(value) {
  assertBossCanonicalData(value, "$.bossControlResult");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Boss control result must be an exact plain object");
  }
  const result = value;
  const base = typeof result.requestId === "string" && result.requestId.length > 0 && result.messageId === result.requestId && typeof result.idempotencyKey === "string" && result.idempotencyKey.length > 0;
  if (!base || result.type !== "boss_control_result") throw new Error("Invalid Boss control result binding");
  if (result.status === "delivered" && result.delivered === true && typeof result.deliveryId === "string" && result.deliveryId.length > 0 && exactStringKeys(result, ["type", "requestId", "messageId", "idempotencyKey", "status", "delivered", "deliveryId"])) return result;
  if (result.status === "rejected" && result.delivered === false && typeof result.code === "string" && BOSS_CONTROL_FAILURE_CODES.has(result.code) && typeof result.reason === "string" && result.reason.length > 0 && (!Object.hasOwn(result, "deliveryId") || typeof result.deliveryId === "string" && result.deliveryId.length > 0) && exactStringKeys(
    result,
    ["type", "requestId", "messageId", "idempotencyKey", "status", "delivered", "code", "reason"],
    ["deliveryId"]
  )) return result;
  throw new Error("Invalid Boss control result discriminant");
}
function parseBossControlAck(value) {
  assertBossCanonicalData(value, "$.bossControlAck");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Boss control acknowledgement must be an exact plain object");
  }
  const ack = value;
  if (!exactStringKeys(ack, ["type", "requestId", "messageId", "idempotencyKey", "status", "deliveryId"]) || ack.type !== "boss_control_ack" || typeof ack.requestId !== "string" || ack.requestId.length === 0 || ack.messageId !== ack.requestId || typeof ack.idempotencyKey !== "string" || ack.idempotencyKey.length === 0 || ack.status !== "accepted" || typeof ack.deliveryId !== "string" || ack.deliveryId.length === 0) throw new Error("Invalid Boss control acknowledgement discriminant");
  return ack;
}

// broker/client.ts
import { types as nodeUtilTypes3 } from "node:util";
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
function connectToBrokerTarget(target) {
  return typeof target === "string" ? net2.connect(target) : net2.connect({ host: target.host, port: target.port });
}
function isAttachment(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const attachment = value;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") {
    return false;
  }
  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }
  return attachment.language === void 0 || typeof attachment.language === "string";
}
function isMessage(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value;
  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }
  if (message.replyTo !== void 0 && typeof message.replyTo !== "string") {
    return false;
  }
  if (message.expectsReply !== void 0 && typeof message.expectsReply !== "boolean") {
    return false;
  }
  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }
  const content = message.content;
  if (typeof content.text !== "string") {
    return false;
  }
  return content.attachments === void 0 || Array.isArray(content.attachments) && content.attachments.every(isAttachment);
}
function isSessionInfo(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value;
  if (typeof session.id !== "string" || typeof session.cwd !== "string" || typeof session.model !== "string" || typeof session.pid !== "number" || typeof session.startedAt !== "number" || typeof session.lastActivity !== "number") {
    return false;
  }
  if (session.name !== void 0 && typeof session.name !== "string") {
    return false;
  }
  if (session.status !== void 0 && typeof session.status !== "string") {
    return false;
  }
  if (session.peerUid !== void 0 && typeof session.peerUid !== "number") {
    return false;
  }
  if (session.trustedLocal !== void 0 && typeof session.trustedLocal !== "boolean") return false;
  if (session.origin !== void 0 && session.origin !== "local" && session.origin !== "remote") return false;
  if (session.remoteHostId !== void 0 && typeof session.remoteHostId !== "string") return false;
  if (session.parentSessionId !== void 0 && typeof session.parentSessionId !== "string") return false;
  if (session.rootSessionId !== void 0 && typeof session.rootSessionId !== "string") return false;
  if (session.generation !== void 0 && (typeof session.generation !== "number" || !Number.isSafeInteger(session.generation))) return false;
  if (session.canDelegate !== void 0 && typeof session.canDelegate !== "boolean") return false;
  for (const field of ["depth", "maxDepth", "maxChildren"]) {
    if (session[field] !== void 0 && (typeof session[field] !== "number" || !Number.isSafeInteger(session[field]))) return false;
  }
  if (session.boss !== void 0) {
    try {
      parseBossParticipantBindingMetadata(session.boss, session.id);
    } catch {
      return false;
    }
  }
  return true;
}
function isRemoteAccessMetadata(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const access = value;
  return access.origin === "remote" && typeof access.remoteHostId === "string" && typeof access.parentSessionId === "string" && typeof access.rootSessionId === "string" && typeof access.generation === "number" && Number.isSafeInteger(access.generation) && access.generation > 0 && typeof access.canDelegate === "boolean" && typeof access.depth === "number" && Number.isSafeInteger(access.depth) && typeof access.maxDepth === "number" && Number.isSafeInteger(access.maxDepth) && typeof access.maxChildren === "number" && Number.isSafeInteger(access.maxChildren) && (access.sessionCredential === void 0 || typeof access.sessionCredential === "string");
}
var IntercomClient = class extends EventEmitter2 {
  socket = null;
  scopeId;
  _sessionId = null;
  pendingSends = /* @__PURE__ */ new Map();
  pendingLists = /* @__PURE__ */ new Map();
  pendingAskControls = /* @__PURE__ */ new Map();
  pendingBossControls = /* @__PURE__ */ new Map();
  outbox = null;
  bossControlOutbox = null;
  remoteAccessCredential;
  requestedBossRegistration;
  _bossBinding;
  disconnecting = false;
  disconnectError = null;
  constructor(options = {}) {
    super();
    this.scopeId = options.scopeId === void 0 ? intercomScopeIdFromEnv(options.env ?? process.env) : parseIntercomScopeId(options.scopeId, "scopeId");
  }
  failPending(error) {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error);
    }
    this.pendingLists.clear();
    for (const pending of this.pendingAskControls.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingAskControls.clear();
    for (const pending of this.pendingBossControls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingBossControls.clear();
  }
  get sessionId() {
    return this._sessionId;
  }
  get outboxSize() {
    return this.outbox?.list().length ?? 0;
  }
  get bossBinding() {
    return this._bossBinding;
  }
  get bossControlOutboxSize() {
    return this.bossControlOutbox?.list().length ?? 0;
  }
  isConnected() {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }
  requireActiveSocket() {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }
    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }
    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }
    return socket;
  }
  connect(session, sessionId) {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }
    try {
      const canonicalSession = parseExactRegistrationFrame({
        type: "register",
        ...typeof session === "object" && session !== null && !nodeUtilTypes3.isProxy(session) && Object.getOwnPropertyDescriptor(session, "boss") !== void 0 ? { registrationKind: "boss" } : {},
        protocol: INTERCOM_PROTOCOL_NAME,
        version: INTERCOM_PROTOCOL_VERSION,
        session
      }).session;
      this.requestedBossRegistration = session.boss === void 0 ? void 0 : parseBossParticipantRegistrationMetadata(session.boss);
      if (canonicalSession !== session) throw new Error("Registration session identity changed during validation");
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise((resolve5, reject) => {
      let socket;
      let target;
      try {
        target = getBrokerConnectTarget();
        this.remoteAccessCredential = loadRemoteAccessCredential();
        socket = connectToBrokerTarget(target);
      } catch (error) {
        reject(toError(error));
        return;
      }
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 1e4);
      let connectionEstablished = false;
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve5();
      };
      const onError = (err) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this._bossBinding = void 0;
        this.requestedBossRegistration = void 0;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };
      const onSocketError = (err) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
        }
      };
      const onReaderError = (error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };
      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };
      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      try {
        writeMessage(socket, {
          type: "register",
          ...session.boss === void 0 ? {} : { registrationKind: "boss" },
          protocol: INTERCOM_PROTOCOL_NAME,
          version: INTERCOM_PROTOCOL_VERSION,
          session,
          ...!this.remoteAccessCredential && sessionId ? { sessionId } : {},
          ...this.remoteAccessCredential ? { access: this.remoteAccessCredential.access } : {},
          ...this.scopeId ? { scopeId: this.scopeId } : {},
          ...typeof target === "string" ? {} : { stateId: target.stateId }
        });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }
  handleBrokerMessage(msg) {
    if (typeof msg !== "object" || msg === null || nodeUtilTypes3.isProxy(msg)) {
      throw new Error("Invalid broker message");
    }
    const typeDescriptor = Object.getOwnPropertyDescriptor(msg, "type");
    if (typeDescriptor === void 0 || !typeDescriptor.enumerable || !Object.hasOwn(typeDescriptor, "value") || typeof typeDescriptor.value !== "string") throw new Error("Invalid broker message");
    const brokerMessage = msg;
    if (this._sessionId === null && brokerMessage.type !== "registered" && brokerMessage.type !== "error") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }
    switch (brokerMessage.type) {
      case "registered": {
        parseExactRegisteredFrame(
          brokerMessage,
          this.requestedBossRegistration === void 0 ? this.remoteAccessCredential === void 0 ? "ordinary-local" : "ordinary-remote" : "boss"
        );
        if (typeof brokerMessage.sessionId !== "string" || brokerMessage.protocol !== INTERCOM_PROTOCOL_NAME || brokerMessage.version !== INTERCOM_PROTOCOL_VERSION) {
          throw new Error("Invalid registered message");
        }
        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }
        if (this.remoteAccessCredential) {
          const contract = brokerMessage.remoteAccess;
          const contractFields = typeof contract === "object" && contract !== null ? contract : void 0;
          if (!contractFields || contractFields.feature !== "remote-access-v1" || contractFields.policySemanticsVersion !== POLICY_SEMANTICS_VERSION || contractFields.policySemanticsHash !== POLICY_SEMANTICS_HASH) {
            throw new Error("Remote Intercom policy contract is absent or incompatible");
          }
          if (!isRemoteAccessMetadata(brokerMessage.access)) {
            throw new Error("Remote Intercom registration omitted broker-owned provenance");
          }
          if (this.remoteAccessCredential.enrollment) {
            writeRemoteSessionCredential(this.remoteAccessCredential.path, brokerMessage.sessionId, brokerMessage.access);
          } else {
            const reconnect = this.remoteAccessCredential.access;
            if (!("sessionId" in reconnect) || reconnect.sessionId !== brokerMessage.sessionId || reconnect.generation !== brokerMessage.access.generation) {
              throw new Error("Remote Intercom reconnect identity or generation changed unexpectedly");
            }
          }
        }
        if (this.requestedBossRegistration !== void 0) {
          if (brokerMessage.remoteAccess !== void 0 || brokerMessage.access !== void 0) {
            throw new Error("Boss registration returned folded remote-access metadata");
          }
          const advertisement = parseBrokerCapabilityAdvertisement2(brokerMessage.capabilities);
          if (!advertisement.features.some((feature) => feature.feature === BOSS_RUN_FEATURE2)) {
            throw new Error("Broker did not echo the required boss-run-v1 feature contract");
          }
          const binding = parseBossParticipantBindingMetadata(brokerMessage.boss, brokerMessage.sessionId);
          const credential = this.requestedBossRegistration.credential;
          if (binding.featureContract.feature !== this.requestedBossRegistration.featureContract.feature || binding.binding.bossRunId !== credential.bossRunId || binding.binding.participantId !== credential.participantId || binding.binding.role !== credential.role || binding.binding.communicationProfile !== credential.communicationProfile || binding.binding.bindingEpoch !== credential.bindingEpoch) {
            throw new Error("Broker returned a Boss binding that does not match the authenticated registration request");
          }
          this._bossBinding = binding;
        } else if (brokerMessage.boss !== void 0) {
          throw new Error("Broker attached unsolicited Boss binding metadata to an ordinary registration");
        }
        this._sessionId = brokerMessage.sessionId;
        this.outbox = new PersistentOutboundOutbox(brokerMessage.sessionId);
        this.bossControlOutbox = this._bossBinding === void 0 ? null : new PersistentBossControlOutbox(brokerMessage.sessionId);
        this.replayOutbox();
        this.replayBossControlOutbox();
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }
      case "sessions": {
        const { requestId, sessions } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
          throw new Error("Invalid sessions message");
        }
        const pending = this.pendingLists.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingLists.delete(requestId);
        pending.resolve(sessions);
        break;
      }
      case "message": {
        const { deliveryId, from, message } = brokerMessage;
        if (typeof deliveryId !== "string" || !isSessionInfo(from) || !isMessage(message)) {
          throw new Error("Invalid message event");
        }
        this.emit("message", from, message, deliveryId);
        break;
      }
      case "boss_control": {
        const { deliveryId, from } = brokerMessage;
        if (typeof deliveryId !== "string" || !isSessionInfo(from)) {
          throw new Error("Invalid boss_control event");
        }
        const envelope = bossControlKind(brokerMessage.envelope).envelope;
        const source = from.boss === void 0 ? void 0 : parseBossParticipantBindingMetadata(from.boss, from.id).binding;
        if (source === void 0 || source.state !== "active" || source.bossRunId !== envelope.bossRunId || source.participantId !== envelope.participantId || source.bindingEpoch !== envelope.bindingEpoch) throw new Error("Boss control event sender does not match its broker-owned binding");
        this.emit("boss_control", from, envelope, deliveryId);
        break;
      }
      case "boss_control_result": {
        const result = parseBossControlResult(brokerMessage);
        const { requestId, messageId, idempotencyKey, deliveryId } = result;
        const stored = this.bossControlOutbox?.find(idempotencyKey);
        if (!stored || stored.envelope.messageId !== requestId) throw new Error("Boss control result does not match the durable outbox binding");
        const pending = this.pendingBossControls.get(requestId);
        if (pending && (pending.messageId !== messageId || pending.idempotencyKey !== idempotencyKey)) {
          throw new Error("Boss control result correlation does not match the pending request");
        }
        this.bossControlOutbox.removeCorrelated(idempotencyKey, messageId, deliveryId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingBossControls.delete(requestId);
          pending.resolve(result);
        }
        break;
      }
      case "boss_control_ack": {
        const { requestId, messageId, idempotencyKey, deliveryId } = parseBossControlAck(brokerMessage);
        const pending = this.pendingBossControls.get(requestId);
        if (pending && (pending.messageId !== messageId || pending.idempotencyKey !== idempotencyKey)) {
          throw new Error("Boss control acknowledgement correlation does not match the pending request");
        }
        const transition = this.bossControlOutbox?.markAccepted(idempotencyKey, messageId, deliveryId);
        if (transition === void 0) throw new Error("Boss control acknowledgement has no durable outbox");
        if (pending?.deliveryId !== void 0 && pending.deliveryId !== deliveryId) {
          throw new Error("Boss control acknowledgement changed the pending deliveryId");
        }
        if (pending) pending.deliveryId = deliveryId;
        break;
      }
      case "delivery_accepted": {
        const { deliveryId, messageId } = brokerMessage;
        if (typeof deliveryId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid delivery_accepted message");
        }
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          return;
        }
        pending.accepted = true;
        pending.deliveryId = deliveryId;
        this.emit("delivery_accepted", messageId, deliveryId);
        break;
      }
      case "delivered": {
        const { deliveryId, messageId } = brokerMessage;
        if (typeof deliveryId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid delivered message");
        }
        this.outbox?.remove(messageId);
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          this.emit("outbox_delivered", messageId, deliveryId);
          return;
        }
        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, accepted: true, delivered: true, deliveryId });
        break;
      }
      case "delivery_failed": {
        const { accepted, code, messageId, reason } = brokerMessage;
        if (typeof accepted !== "boolean" || typeof code !== "string" || typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid delivery_failed message");
        }
        this.outbox?.remove(messageId);
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          this.emit("outbox_failed", messageId, code, reason);
          return;
        }
        this.pendingSends.delete(messageId);
        pending.resolve({
          id: messageId,
          accepted,
          delivered: false,
          code,
          reason,
          ...pending.deliveryId ? { deliveryId: pending.deliveryId } : {}
        });
        break;
      }
      case "ask_deferred": {
        const { fromSessionId, messageId } = brokerMessage;
        if (typeof fromSessionId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid ask_deferred message");
        }
        this.emit("ask_deferred", messageId, fromSessionId);
        break;
      }
      case "ask_cancelled": {
        const { fromSessionId, messageId, reason } = brokerMessage;
        if (typeof fromSessionId !== "string" || typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid ask_cancelled message");
        }
        this.emit("ask_cancelled", messageId, fromSessionId, reason);
        break;
      }
      case "ask_control_result": {
        const { action, applied, messageId, requestId } = brokerMessage;
        if (action !== "defer" && action !== "cancel" || typeof applied !== "boolean" || typeof messageId !== "string" || typeof requestId !== "string") {
          throw new Error("Invalid ask_control_result message");
        }
        const pending = this.pendingAskControls.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingAskControls.delete(requestId);
        pending.resolve(applied);
        break;
      }
      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }
        this.emit("session_joined", brokerMessage.session);
        break;
      }
      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }
      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }
        this.emit("presence_update", brokerMessage.session);
        break;
      }
      case "error": {
        if (typeof brokerMessage.code !== "string" || typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }
        if (this._sessionId === null) {
          const error2 = new Error(brokerMessage.error);
          error2.code = brokerMessage.code;
          throw error2;
        }
        const error = new Error(brokerMessage.error);
        error.code = brokerMessage.code;
        this.emit("error", error);
        break;
      }
      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }
  async disconnect(preserveAsks = false) {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new Error("Client disconnected"));
    if (!preserveAsks) this.outbox?.clear();
    await new Promise((resolve5) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve5();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2e3);
      socket.once("close", onClose);
      socket.once("error", onError);
      try {
        writeMessage(socket, { type: "unregister", ...preserveAsks ? { preserveAsks: true } : {} });
        socket.end();
      } catch {
        socket.destroy();
      }
    });
  }
  listSessions() {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise((resolve5, reject) => {
      const requestId = randomUUID2();
      const wrappedResolve = (sessions) => {
        clearTimeout(timeout);
        resolve5(sessions);
      };
      const wrappedReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, 5e3);
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  }
  send(to, options) {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const messageId = options.messageId ?? randomUUID2();
    if (this.pendingSends.has(messageId)) {
      return Promise.resolve({
        id: messageId,
        accepted: false,
        delivered: false,
        code: "DUPLICATE_MESSAGE_ID",
        reason: `Message ID ${messageId} is already pending`
      });
    }
    const message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: {
        text: options.text,
        attachments: options.attachments
      }
    };
    try {
      this.outbox?.enqueue(to, message);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise((resolve5, reject) => {
      const wrappedResolve = (result) => {
        clearTimeout(timeout);
        resolve5(result);
      };
      const wrappedReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, 1e4);
      this.pendingSends.set(messageId, {
        accepted: false,
        resolve: wrappedResolve,
        reject: wrappedReject
      });
      try {
        writeMessage(socket, { type: "send", to, message });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }
  sendBossControl(to, envelopeValue) {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    let envelope;
    try {
      envelope = bossControlKind(envelopeValue).envelope;
      const binding = this._bossBinding?.binding;
      if (binding === void 0 || binding.state !== "active" || envelope.bossRunId !== binding.bossRunId || envelope.participantId !== binding.participantId || envelope.bindingEpoch !== binding.bindingEpoch) throw new Error("Boss control envelope does not match this client's active participant binding");
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = envelope.messageId;
    if (this.pendingBossControls.has(requestId)) {
      return Promise.resolve({
        requestId,
        messageId: envelope.messageId,
        idempotencyKey: envelope.idempotencyKey,
        status: "rejected",
        delivered: false,
        code: "INVALID_CONTROL",
        reason: "Boss requestId is already pending"
      });
    }
    try {
      if (!this.bossControlOutbox) throw new Error("Durable Boss control outbox is unavailable");
      this.bossControlOutbox.enqueue(to, envelope);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise((resolve5, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingBossControls.delete(requestId)) return;
        reject(new Error("Boss control delivery timeout"));
      }, 1e4);
      timeout.unref?.();
      this.pendingBossControls.set(requestId, {
        messageId: envelope.messageId,
        idempotencyKey: envelope.idempotencyKey,
        resolve: resolve5,
        reject,
        timeout
      });
      try {
        writeMessage(socket, { type: "boss_control", requestId, to, envelope });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingBossControls.delete(requestId);
        reject(toError(error));
      }
    });
  }
  acknowledgeBossControl(deliveryId, messageId, idempotencyKey) {
    return this.writeControlMessage({ type: "boss_control_received", deliveryId, messageId, idempotencyKey });
  }
  acknowledgeMessage(deliveryId) {
    return this.writeControlMessage({ type: "message_received", deliveryId });
  }
  rejectMessage(deliveryId, reason) {
    return this.writeControlMessage({ type: "message_rejected", deliveryId, code: "CONFLICTING_MESSAGE_ID", reason });
  }
  deferAsk(messageId) {
    return this.sendAskControl("defer", messageId);
  }
  cancelAsk(messageId) {
    return this.sendAskControl("cancel", messageId);
  }
  sendAskControl(action, messageId) {
    const requestId = randomUUID2();
    return new Promise((resolve5) => {
      const timeout = setTimeout(() => {
        this.pendingAskControls.delete(requestId);
        resolve5(false);
      }, 2e3);
      timeout.unref?.();
      this.pendingAskControls.set(requestId, { resolve: resolve5, timeout });
      if (!this.writeControlMessage({ type: action === "defer" ? "defer_ask" : "cancel_ask", requestId, messageId })) {
        clearTimeout(timeout);
        this.pendingAskControls.delete(requestId);
        resolve5(false);
      }
    });
  }
  writeControlMessage(message) {
    if (this.disconnecting) {
      return false;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return false;
    }
    try {
      writeMessage(socket, message);
      return true;
    } catch {
      return false;
    }
  }
  replayOutbox() {
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) return;
    for (const entry of this.outbox?.list() ?? []) {
      if (this.pendingSends.has(entry.message.id)) continue;
      try {
        writeMessage(socket, { type: "send", to: entry.to, message: entry.message });
      } catch {
        return;
      }
    }
  }
  replayBossControlOutbox() {
    const socket = this.socket;
    if (!socket || socket.destroyed || !this._sessionId || !this.bossControlOutbox) return;
    for (const entry of this.bossControlOutbox.list()) {
      try {
        writeMessage(socket, {
          type: "boss_control",
          requestId: entry.envelope.messageId,
          to: entry.to,
          envelope: entry.envelope
        });
      } catch {
        return;
      }
    }
  }
  updatePresence(updates) {
    if (this.disconnecting) {
      return;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }
    writeMessage(socket, { type: "presence", ...updates });
  }
};

// broker/spawn.ts
import { spawn as spawn2 } from "child_process";
import { existsSync as existsSync4, readFileSync as readFileSync6, unlinkSync, writeFileSync as writeFileSync3 } from "fs";
import { join as join5, dirname as dirname3 } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net3 from "net";
import { randomUUID as randomUUID3 } from "crypto";
import { POLICY_SEMANTICS_HASH as POLICY_SEMANTICS_HASH2, POLICY_SEMANTICS_VERSION as POLICY_SEMANTICS_VERSION2 } from "@ctliz/agent-intercom-core";
var INTERCOM_DIR = getIntercomDirPath();
var EXTENSION_DIR = join5(dirname3(fileURLToPath(import.meta.url)), "..");
var BROKER_PID = join5(INTERCOM_DIR, "broker.pid");
var BROKER_SPAWN_LOCK = join5(INTERCOM_DIR, "broker.spawn.lock");
function sleep(ms) {
  return new Promise((resolve5) => setTimeout(resolve5, ms));
}
function getBrokerEntryPath(moduleUrl = import.meta.url) {
  const moduleDir = dirname3(fileURLToPath(moduleUrl));
  const bundledBroker = join5(moduleDir, "broker.mjs");
  return existsSync4(bundledBroker) ? bundledBroker : join5(moduleDir, "broker.ts");
}
function getTsxCliPath(extensionDir = EXTENSION_DIR) {
  try {
    const requireFromExtension = createRequire(import.meta.url);
    const tsxMain = requireFromExtension.resolve("tsx");
    return join5(dirname3(tsxMain), "cli.mjs");
  } catch {
    return join5(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
  }
}
function quoteWindowsArg(value) {
  return `"${value.replace(/"/g, '""')}"`;
}
function getWindowsHiddenLauncherPath(intercomDir = INTERCOM_DIR) {
  return join5(intercomDir, "broker-launch.vbs");
}
function usesDefaultBrokerCommand(brokerCommand, brokerArgs) {
  return brokerCommand === "npx" && brokerArgs.length === 2 && brokerArgs[0] === "--no-install" && brokerArgs[1] === "tsx";
}
function getWindowsBrokerCommandLine(brokerPath, extensionDir = EXTENSION_DIR, nodePath = process.execPath, brokerCommand = "npx", brokerArgs = ["--no-install", "tsx"]) {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return [quoteWindowsArg(nodePath), quoteWindowsArg(getTsxCliPath(extensionDir)), quoteWindowsArg(brokerPath)].join(" ");
  }
  return [quoteWindowsArg(brokerCommand), ...brokerArgs.map(quoteWindowsArg), quoteWindowsArg(brokerPath)].join(" ");
}
function getWindowsHiddenLauncherScript(commandLine) {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    "Set WshShell = Nothing",
    ""
  ].join("\r\n");
}
function isBrokerHealthOkMessage(message, requestId) {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }
  const response = message;
  if (response.type !== "health_ok" || response.requestId !== requestId || response.protocol !== INTERCOM_PROTOCOL_NAME || response.version !== INTERCOM_PROTOCOL_VERSION || response.endpoint !== "local") return false;
  const remoteAccess = response.remoteAccess;
  if (typeof remoteAccess !== "object" || remoteAccess === null || Array.isArray(remoteAccess)) return false;
  const contract = remoteAccess;
  return contract.feature === "remote-access-v1" && contract.policySemanticsVersion === POLICY_SEMANTICS_VERSION2 && contract.policySemanticsHash === POLICY_SEMANTICS_HASH2;
}
function writeWindowsHiddenLauncher(commandLine, launcherPath = getWindowsHiddenLauncherPath()) {
  ensureIntercomRuntimeDir(dirname3(launcherPath));
  writeFileSync3(launcherPath, getWindowsHiddenLauncherScript(commandLine), {
    encoding: "utf-8",
    mode: INTERCOM_RUNTIME_FILE_MODE
  });
  restrictIntercomRuntimeFile(launcherPath);
  return launcherPath;
}
function getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs, extensionDir = EXTENSION_DIR, platform = process.platform, intercomDir = INTERCOM_DIR, nodePath = process.execPath) {
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: [launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsBrokerCommandLine(brokerPath, extensionDir, nodePath, brokerCommand, brokerArgs)
    };
  }
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return {
      kind: "direct",
      command: nodePath,
      args: [getTsxCliPath(extensionDir), brokerPath]
    };
  }
  return {
    kind: "direct",
    command: brokerCommand,
    args: [...brokerArgs, brokerPath]
  };
}
function getBrokerSpawnOptions(extensionDir = EXTENSION_DIR, env = process.env) {
  return {
    detached: true,
    stdio: "ignore",
    cwd: extensionDir,
    env: { ...env, PI_CODING_AGENT_DIR: getAgentDirPath(env), NODE_NO_WARNINGS: "1" },
    windowsHide: true
  };
}
function toError2(error) {
  return error instanceof Error ? error : new Error(String(error));
}
async function spawnBrokerIfNeeded(brokerCommand, brokerArgs) {
  ensureIntercomRuntimeDir(INTERCOM_DIR);
  if (await isBrokerRunning()) {
    return;
  }
  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }
  try {
    if (await isBrokerRunning()) {
      return;
    }
    if (await checkBrokerHealth() === "incompatible") {
      throw new Error(`Incompatible live intercom broker; expected ${INTERCOM_PROTOCOL_NAME} v${INTERCOM_PROTOCOL_VERSION}. Stop it explicitly during a coordinated migration.`);
    }
    const brokerPath = getBrokerEntryPath();
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    const child = spawn2(launch.command, launch.args, getBrokerSpawnOptions());
    child.unref();
    await new Promise((resolve5, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error.message}`, { cause: error }));
      };
      const onExit = (code, signal) => {
        if (launch.kind === "windows-launcher" && code === 0 && signal === null) {
          return;
        }
        cleanup();
        if (signal) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker().then(() => {
        cleanup();
        resolve5();
      }, (error) => {
        cleanup();
        reject(toError2(error));
      });
    });
  } finally {
    releaseSpawnLock();
  }
}
async function isBrokerRunning() {
  if (await checkSocketConnectable()) {
    return true;
  }
  if (!existsSync4(BROKER_PID)) return false;
  try {
    const pid = parseInt(readFileSync6(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    return false;
  }
}
function connectToBrokerTarget2(target) {
  return typeof target === "string" ? net3.connect(target) : net3.connect({ host: target.host, port: target.port });
}
async function checkSocketConnectable() {
  return await checkBrokerHealth() === "compatible";
}
function checkBrokerHealth() {
  return new Promise((resolve5) => {
    let target;
    try {
      target = getBrokerConnectTarget();
    } catch {
      resolve5("unreachable");
      return;
    }
    const socket = connectToBrokerTarget2(target);
    const requestId = randomUUID3();
    const expectedStateId = typeof target === "string" ? void 0 : target.stateId;
    let settled = false;
    const finish = (health) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("data", reader);
      socket.destroy();
      resolve5(health);
    };
    const onConnect = () => {
      try {
        writeMessage(socket, {
          type: "health",
          requestId,
          ...expectedStateId ? { stateId: expectedStateId } : {}
        });
      } catch {
        finish("unreachable");
      }
    };
    const onError = () => finish("unreachable");
    const reader = createMessageReader((message) => {
      if (isBrokerHealthOkMessage(message, requestId)) {
        finish("compatible");
        return;
      }
      if (typeof message === "object" && message !== null && "type" in message && message.type === "health_ok" && "requestId" in message && message.requestId === requestId) {
        finish("incompatible");
        return;
      }
      finish("unreachable");
    }, () => finish("unreachable"));
    socket.on("connect", onConnect);
    socket.on("error", onError);
    socket.on("data", reader);
    const timeout = setTimeout(() => finish("unreachable"), 1e3);
  });
}
function acquireSpawnLock() {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync3(BROKER_SPAWN_LOCK, `${process.pid}
${Date.now()}
`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE
      });
      restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
        }
        continue;
      }
      return false;
    }
  }
  return false;
}
function isSpawnLockStale() {
  if (!existsSync4(BROKER_SPAWN_LOCK)) {
    return false;
  }
  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync6(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
    }
    return !Number.isFinite(createdAt) || ageMs > 1e4;
  } catch {
    return true;
  }
}
function releaseSpawnLock() {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
  }
}
async function waitForBroker(timeoutMs = 5e3) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}

// config.ts
import { existsSync as existsSync5, readFileSync as readFileSync7 } from "fs";
import { join as join6, resolve as resolve3 } from "path";
import { homedir as homedir2 } from "os";
var DEFAULT_ASK_TIMEOUT_MS = 45 * 1e3;
var MAX_ASK_TIMEOUT_MS = 120 * 1e3;
function validateAskTimeoutMs(value, name = "timeout_ms") {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  if (value > MAX_ASK_TIMEOUT_MS) {
    throw new Error(`${name} must be ${MAX_ASK_TIMEOUT_MS} ms or less; use intercom_send plus intercom_pending for longer-running work`);
  }
  return value;
}
function getConfigPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve3(process.env.PI_CODING_AGENT_DIR) : join6(homedir2(), ".pi", "agent");
  return join6(agentDir, "intercom", "config.json");
}
var defaults = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  confirmSend: false,
  enabled: true,
  replyHint: true,
  inboundForkHandlers: {
    enabled: true,
    when: "auto",
    notify: "summary",
    triggerParentOnSummary: "auto"
  }
};
function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync5(configPath)) {
    return { ...defaults };
  }
  try {
    const raw = readFileSync7(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }
    const parsedConfig = parsed;
    const config = { ...defaults };
    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }
    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }
    if (Object.hasOwn(parsedConfig, "confirmSend")) {
      if (typeof parsedConfig.confirmSend !== "boolean") {
        throw new Error(`"confirmSend" must be a boolean`);
      }
      config.confirmSend = parsedConfig.confirmSend;
    }
    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }
    if (Object.hasOwn(parsedConfig, "replyHint")) {
      if (typeof parsedConfig.replyHint !== "boolean") {
        throw new Error(`"replyHint" must be a boolean`);
      }
      config.replyHint = parsedConfig.replyHint;
    }
    if (Object.hasOwn(parsedConfig, "status")) {
      if (typeof parsedConfig.status !== "string") {
        throw new Error(`"status" must be a string`);
      }
      config.status = parsedConfig.status;
    }
    if (Object.hasOwn(parsedConfig, "inboundForkHandlers")) {
      if (typeof parsedConfig.inboundForkHandlers !== "object" || parsedConfig.inboundForkHandlers === null || Array.isArray(parsedConfig.inboundForkHandlers)) {
        throw new Error(`"inboundForkHandlers" must be an object`);
      }
      const forkConfig = parsedConfig.inboundForkHandlers;
      config.inboundForkHandlers = { ...defaults.inboundForkHandlers };
      if (Object.hasOwn(forkConfig, "enabled")) {
        if (typeof forkConfig.enabled !== "boolean") throw new Error(`"inboundForkHandlers.enabled" must be a boolean`);
        config.inboundForkHandlers.enabled = forkConfig.enabled;
      }
      if (Object.hasOwn(forkConfig, "when")) {
        if (forkConfig.when !== "auto" && forkConfig.when !== "busy" && forkConfig.when !== "always") throw new Error(`"inboundForkHandlers.when" must be "auto", "busy", or "always"`);
        config.inboundForkHandlers.when = forkConfig.when;
      }
      if (Object.hasOwn(forkConfig, "notify")) {
        if (forkConfig.notify !== "ack-and-summary" && forkConfig.notify !== "summary" && forkConfig.notify !== "none") throw new Error(`"inboundForkHandlers.notify" must be "ack-and-summary", "summary", or "none"`);
        config.inboundForkHandlers.notify = forkConfig.notify;
      }
      if (Object.hasOwn(forkConfig, "piCommand")) {
        if (typeof forkConfig.piCommand !== "string") throw new Error(`"inboundForkHandlers.piCommand" must be a string`);
        const piCommand = forkConfig.piCommand.trim();
        if (piCommand) config.inboundForkHandlers.piCommand = piCommand;
      }
      if (Object.hasOwn(forkConfig, "triggerParentOnSummary")) {
        const triggerParentOnSummary = forkConfig.triggerParentOnSummary;
        if (typeof triggerParentOnSummary !== "boolean" && triggerParentOnSummary !== "auto") {
          throw new Error(`"inboundForkHandlers.triggerParentOnSummary" must be a boolean or "auto"`);
        }
        config.inboundForkHandlers.triggerParentOnSummary = triggerParentOnSummary;
      }
    }
    return config;
  } catch (error) {
    console.error(`Failed to load intercom config at ${configPath}:`, error);
    return { ...defaults };
  }
}

// codex/contact.ts
function duplicateSessionNames(sessions) {
  const counts = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const name = session.name?.trim().toLowerCase();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}
function chooseContactTarget(currentSession, sessions) {
  const duplicates = duplicateSessionNames(sessions);
  const name = currentSession.name?.trim() || void 0;
  const duplicateName = Boolean(name && duplicates.has(name.toLowerCase()));
  return {
    target: name && !duplicateName ? name : currentSession.id,
    id: currentSession.id,
    ...name ? { name } : {},
    duplicateName
  };
}
function formatContactInstruction(contact) {
  if (contact.target === contact.id) {
    return `Intercom send ID: ${contact.id}`;
  }
  return `Intercom send ID: ${contact.target} (full ID: ${contact.id})`;
}
async function resolveContactTarget(id, name, listSessions) {
  try {
    const sessions = await listSessions();
    const currentSession = sessions.find((session) => session.id === id);
    if (currentSession) return chooseContactTarget(currentSession, sessions);
  } catch {
  }
  return { target: id, id, ...name ? { name } : {}, duplicateName: false, fallback: true };
}

// codex/team.ts
import { readFile } from "node:fs/promises";
import { join as join7 } from "node:path";
import {
  BOSS_PARTICIPANT_ROLES,
  parseParticipantState as parseParticipantState2,
  parseWorkerIdentityV2 as parseWorkerIdentityV22,
  workerIdentityFromEnvironment
} from "@ctliz/agent-intercom-core/boss";
import { readTeamManifestAsync, TeamManifestError } from "@ctliz/agent-intercom-core/team-manifest";
var LEGACY_LIVE_STATES = /* @__PURE__ */ new Set(["provisioning", "running", "idle", "needs_attention", "stopping"]);
var CANONICAL_LIVE_STATES = /* @__PURE__ */ new Set(["provisioning", "registering", "ready", "working", "waiting", "paused", "stalled", "blocked", "unreachable"]);
var stringValue = (value) => typeof value === "string" && value.trim() ? value.trim() : void 0;
var connectedTo = (sessions, target) => {
  const normalized = target.toLowerCase();
  return sessions.some((session) => session.id === target || session.name?.toLowerCase() === normalized);
};
function hasBossEnvironmentKeys(env) {
  const bossKeys = [
    "AGENT_INTERCOM_BOSS_RUN_ID",
    "AGENT_INTERCOM_PARTICIPANT_ID",
    "AGENT_INTERCOM_BINDING_EPOCH",
    "AGENT_INTERCOM_WORKER_INCARNATION_ID",
    "AGENT_INTERCOM_WORKER_GENERATION"
  ];
  return bossKeys.some((key) => env[key] !== void 0);
}
function bossIdentityFromEnvironment(env) {
  if (!hasBossEnvironmentKeys(env)) return void 0;
  try {
    const identity = workerIdentityFromEnvironment(env);
    if (!("bossRunId" in identity)) return void 0;
    return identity;
  } catch {
    return void 0;
  }
}
function canonicalWorker(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("worker must be an object");
  const worker = value;
  const identity = parseWorkerIdentityV22({
    version: "orc.worker-identity.v2",
    workerId: worker.id,
    workerIncarnationId: worker.workerIncarnationId,
    workerGeneration: worker.workerGeneration,
    ...worker.bossRunId === void 0 ? {} : { bossRunId: worker.bossRunId },
    ...worker.participantId === void 0 ? {} : { participantId: worker.participantId },
    ...worker.bindingEpoch === void 0 ? {} : { bindingEpoch: worker.bindingEpoch }
  });
  parseParticipantState2(worker.state, "$.worker.state");
  if (typeof worker.role !== "string" || !BOSS_PARTICIPANT_ROLES.includes(worker.role)) {
    throw new Error("worker role is not canonical");
  }
  if (worker.owned !== true || !stringValue(worker.managerSessionId) || !stringValue(worker.intercomTarget)) {
    throw new Error("canonical worker ownership routing is incomplete");
  }
  return { ...worker, canonicalIdentity: identity };
}
function exactBossRosterSession(sessions, worker) {
  const identity = worker.canonicalIdentity;
  const target = stringValue(worker.intercomTarget);
  const role = stringValue(worker.role);
  const state = stringValue(worker.state);
  if (!identity || !("bossRunId" in identity) || !target || !role || !state) return void 0;
  const matches = sessions.filter((candidate) => candidate.id === target);
  if (matches.length !== 1) return void 0;
  const [session] = matches;
  if (!session?.boss?.binding || session.boss.workerIdentity === void 0 || session.boss.participantState === void 0) return void 0;
  try {
    const sessionIdentity = parseWorkerIdentityV22(session.boss.workerIdentity);
    const sessionState = parseParticipantState2(session.boss.participantState, "$.session.boss.participantState");
    const binding = session.boss.binding;
    return "bossRunId" in sessionIdentity && session.id === target && binding.sessionId === session.id && binding.state === "active" && binding.bossRunId === identity.bossRunId && binding.participantId === identity.participantId && binding.bindingEpoch === identity.bindingEpoch && binding.role === role && sessionIdentity.workerId === identity.workerId && sessionIdentity.workerIncarnationId === identity.workerIncarnationId && sessionIdentity.workerGeneration === identity.workerGeneration && sessionIdentity.bossRunId === identity.bossRunId && sessionIdentity.participantId === identity.participantId && sessionIdentity.bindingEpoch === identity.bindingEpoch && sessionState === state ? session : void 0;
  } catch {
    return void 0;
  }
}
async function readWorkers(agentDir) {
  try {
    const parsed = JSON.parse(await readFile(join7(agentDir, "intercom", "orchestrator", "workers.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("worker snapshot must be an object");
    const snapshot = parsed;
    if (snapshot.version !== 1 && snapshot.version !== 2 || !Array.isArray(snapshot.workers)) throw new Error("unsupported worker snapshot version");
    if (snapshot.version === 1) return { version: 1, workers: snapshot.workers };
    return { version: 2, workers: snapshot.workers.map(canonicalWorker) };
  } catch {
    return { version: 1, workers: [] };
  }
}
async function resolveNonAuthoritativeTeam(input, env) {
  if (env.AGENT_INTERCOM_TEAM_MANIFEST !== void 0) {
    const rawPath = env.AGENT_INTERCOM_TEAM_MANIFEST.trim();
    if (!rawPath) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }
    const manifest = await readTeamManifestAsync(rawPath);
    if (!manifest) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }
    const selfMember = manifest.members.find((m) => m.sessionId === input.selfId);
    if (!selfMember) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }
    const isManager = input.selfId === manifest.leadId;
    const managerTarget2 = manifest.leadId;
    const managerConnected = connectedTo(input.sessions, managerTarget2);
    const coworkers = manifest.members.filter((m) => m.sessionId !== input.selfId).filter((m) => isManager || m.sessionId !== managerTarget2).map((m) => {
      const live = input.sessions.find((s) => s.id === m.sessionId || s.name === m.sessionId);
      return {
        id: m.sessionId,
        target: m.sessionId,
        role: m.role,
        connected: Boolean(live)
      };
    });
    return {
      teamId: manifest.runId,
      self: { id: input.selfId, isManager },
      manager: { target: managerTarget2, connected: managerConnected },
      coworkers,
      source: "manifest"
    };
  }
  if (stringValue(env.AGENT_INTERCOM_SCOPE_ID)) {
    const managerTarget2 = stringValue(env.AGENT_INTERCOM_MANAGER_TARGET) ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
    const role = stringValue(env.AGENT_INTERCOM_ROLE)?.toLowerCase();
    const isManager = role === "manager" || managerTarget2 !== void 0 && managerTarget2 === input.selfId || managerTarget2 === void 0 && role !== "worker";
    const effectiveManagerTarget = isManager ? input.selfId : managerTarget2;
    const coworkers = input.sessions.filter((session) => session.id !== input.selfId).filter((session) => session.model !== "human").filter((session) => session.id !== effectiveManagerTarget).map((session) => ({
      id: session.id,
      target: session.id,
      ...session.model ? { harness: session.model } : {},
      connected: true
    }));
    const manager = effectiveManagerTarget ? {
      target: effectiveManagerTarget,
      connected: isManager ? true : connectedTo(input.sessions, effectiveManagerTarget)
    } : void 0;
    return {
      teamId: effectiveManagerTarget ?? input.selfId,
      self: { id: input.selfId, isManager },
      ...manager ? { manager } : {},
      coworkers,
      source: "live"
    };
  }
  const managerTarget = stringValue(env.AGENT_INTERCOM_MANAGER_TARGET) ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
  return {
    teamId: managerTarget ?? input.selfId,
    self: { id: input.selfId, isManager: !managerTarget },
    manager: managerTarget ? { target: managerTarget, connected: connectedTo(input.sessions, managerTarget) } : { target: input.selfId, connected: true },
    coworkers: [],
    source: "standalone"
  };
}
async function resolveIntercomTeam(input) {
  const env = input.env ?? process.env;
  const snapshot = await readWorkers(input.agentDir ?? getAgentDirPath());
  const workers = snapshot.workers;
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  const selfSession = input.sessions.find((session) => session.id === input.selfId);
  const isBossContext = selfSession?.boss !== void 0 || hasBossEnvironmentKeys(env);
  const bossIdentity = bossIdentityFromEnvironment(env);
  const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);
  if (isBossContext && bossIdentity === void 0) {
    return {
      self: { id: input.selfId, ...workerId ? { workerId } : {}, isManager: false },
      coworkers: [],
      source: "boss"
    };
  }
  const currentMatches = workerId ? workers.filter((worker) => stringValue(worker.id) === workerId && (bossIdentity === void 0 ? snapshot.version === 1 && (!runId || stringValue(worker.runId) === runId) : snapshot.version === 2 && worker.canonicalIdentity?.workerId === bossIdentity.workerId && worker.canonicalIdentity.workerIncarnationId === bossIdentity.workerIncarnationId && worker.canonicalIdentity.workerGeneration === bossIdentity.workerGeneration && "bossRunId" in worker.canonicalIdentity && "bossRunId" in bossIdentity && worker.canonicalIdentity.bossRunId === bossIdentity.bossRunId && worker.canonicalIdentity.participantId === bossIdentity.participantId && worker.canonicalIdentity.bindingEpoch === bossIdentity.bindingEpoch)) : [];
  const current = bossIdentity === void 0 ? currentMatches[0] : currentMatches.length === 1 ? currentMatches[0] : void 0;
  const currentTarget = stringValue(current?.intercomTarget);
  const exactCurrentProjection = current !== void 0 && currentTarget === input.selfId && workers.filter((worker) => stringValue(worker.id) === workerId).length === 1 && workers.filter((worker) => stringValue(worker.intercomTarget) === currentTarget).length === 1 && exactBossRosterSession(input.sessions, current) !== void 0;
  if (bossIdentity !== void 0 && !exactCurrentProjection) {
    return { self: { id: input.selfId, ...workerId ? { workerId } : {}, isManager: false }, coworkers: [], source: "boss" };
  }
  if (bossIdentity === void 0 && !current) {
    if (workerId === void 0 && snapshot.version === 1) {
      const ownedCoworkers = workers.filter((worker) => worker.owned === true).filter((worker) => {
        const mgr = stringValue(worker.managerSessionId);
        return mgr !== void 0 && mgr === input.selfId;
      }).filter((worker) => LEGACY_LIVE_STATES.has(stringValue(worker.state) ?? "")).filter((worker) => stringValue(worker.id) !== input.selfId).map((worker) => {
        const id = stringValue(worker.id);
        if (!id) return void 0;
        const target = stringValue(worker.intercomTarget) ?? id;
        return {
          id,
          target,
          ...stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {},
          ...stringValue(worker.role) ? { role: stringValue(worker.role) } : {},
          ...stringValue(worker.state) ? { state: stringValue(worker.state) } : {},
          connected: connectedTo(input.sessions, target)
        };
      }).filter((member) => Boolean(member));
      if (ownedCoworkers.length > 0) {
        return {
          teamId: input.selfId,
          self: { id: input.selfId, isManager: true },
          manager: { target: input.selfId, connected: true },
          coworkers: ownedCoworkers,
          source: "orchestrator"
        };
      }
    }
    return resolveNonAuthoritativeTeam(input, env);
  }
  const currentRole = stringValue(current?.role);
  const selfIsManager = bossIdentity !== void 0 ? currentRole === "manager" : void 0;
  const managerTarget = bossIdentity !== void 0 ? selfIsManager ? input.selfId : stringValue(current?.managerSessionId) : stringValue(current?.managerSessionId) ?? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET) ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
  if (bossIdentity === void 0 && !managerTarget) {
    return {
      self: { id: input.selfId, ...workerId ? { workerId } : {}, isManager: false },
      coworkers: [],
      source: "orchestrator"
    };
  }
  const teamId = bossIdentity !== void 0 ? "bossRunId" in bossIdentity ? bossIdentity.bossRunId : managerTarget ?? input.selfId : managerTarget ?? input.selfId;
  const canDiscoverOwnedRoster = bossIdentity === void 0 || currentRole === "manager" || currentRole === "controller";
  const coworkers = (canDiscoverOwnedRoster ? workers : []).filter((worker) => worker.owned === true).filter((worker) => bossIdentity === void 0 || snapshot.version === 2 && worker.canonicalIdentity !== void 0 && "bossRunId" in worker.canonicalIdentity && "bossRunId" in bossIdentity && worker.canonicalIdentity.bossRunId === bossIdentity.bossRunId).filter((worker) => stringValue(worker.managerSessionId) === (bossIdentity !== void 0 ? managerTarget : teamId)).filter((worker) => stringValue(worker.intercomTarget) !== managerTarget).filter((worker) => (snapshot.version === 2 ? CANONICAL_LIVE_STATES : LEGACY_LIVE_STATES).has(stringValue(worker.state) ?? "")).filter((worker) => stringValue(worker.id) !== workerId && stringValue(worker.id) !== input.selfId).map((worker) => {
    const id = stringValue(worker.id);
    if (!id) return void 0;
    const target = stringValue(worker.intercomTarget) ?? id;
    const connected = bossIdentity === void 0 ? connectedTo(input.sessions, target) : exactBossRosterSession(input.sessions, worker) !== void 0;
    if (!connected) return void 0;
    return {
      id,
      target,
      ...stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {},
      ...stringValue(worker.role) ? { role: stringValue(worker.role) } : {},
      ...stringValue(worker.state) ? { state: stringValue(worker.state) } : {},
      connected
    };
  }).filter((member) => Boolean(member));
  const managerWorker = managerTarget === void 0 ? void 0 : workers.find((worker) => stringValue(worker.intercomTarget) === managerTarget && (bossIdentity === void 0 || snapshot.version === 2 && stringValue(worker.role) === "manager" && worker.canonicalIdentity !== void 0 && "bossRunId" in worker.canonicalIdentity && "bossRunId" in bossIdentity && worker.canonicalIdentity.bossRunId === bossIdentity.bossRunId));
  const managerConnected = managerTarget === void 0 ? true : bossIdentity === void 0 ? connectedTo(input.sessions, managerTarget) : managerWorker !== void 0 && exactBossRosterSession(input.sessions, managerWorker) !== void 0;
  const isManager = bossIdentity !== void 0 ? selfIsManager : false;
  return {
    teamId,
    self: { id: input.selfId, ...workerId ? { workerId } : {}, isManager },
    ...managerTarget ? { manager: { target: managerTarget, connected: isManager ? true : managerConnected } } : {},
    coworkers,
    source: bossIdentity !== void 0 ? "boss" : "orchestrator"
  };
}
function formatIntercomTeam(team) {
  const lines = [
    `Manager: ${team.manager ? `${team.manager.target} [${team.manager.connected ? "connected" : "not connected"}]` : "unknown"}`,
    `You: ${team.self.workerId ?? team.self.id}${team.self.isManager ? " [manager]" : ""}`
  ];
  if (!team.coworkers.length) lines.push("Coworkers: none");
  else {
    lines.push("Coworkers:");
    for (const coworker of team.coworkers) {
      const metadata = [coworker.harness, coworker.role, coworker.state].filter(Boolean).join(", ");
      lines.push(`- ${coworker.id} target=${coworker.target}${metadata ? ` (${metadata})` : ""} [${coworker.connected ? "connected" : "not connected"}]`);
    }
  }
  return lines.join("\n");
}

// codex/runtime.ts
function formatAttachments(attachments) {
  if (!attachments?.length) return "";
  return attachments.map((attachment) => {
    if (attachment.language) {
      return `

---
Attachment: ${attachment.name}
~~~${attachment.language}
${attachment.content}
~~~`;
    }
    return `

---
Attachment: ${attachment.name}
${attachment.content}`;
  }).join("");
}
function resolveSessionTarget(sessions, nameOrId) {
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
function formatSessionDisplay(session) {
  const name = session.name || session.id;
  return session.origin === "remote" ? `${name} [remote:${session.remoteHostId || "unknown-host"}]` : name;
}
function formatSessionList(sessions, currentSessionId, currentCwd) {
  if (!sessions.length) return "No intercom sessions connected.";
  return sessions.map((session) => {
    const tags = [
      session.id === currentSessionId ? "self" : void 0,
      session.cwd === currentCwd ? "same cwd" : void 0,
      session.status
    ].filter((tag) => Boolean(tag));
    const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- ${formatSessionDisplay(session)} (${session.id.slice(0, 8)}) - ${session.cwd} (${session.model})${suffix}`;
  }).join("\n");
}

// codex/bridge-daemon.ts
var APPROVED_INTERCOM_TOOLS = /* @__PURE__ */ new Set([
  "intercom_whoami",
  "intercom_team",
  "intercom_status",
  "intercom_list",
  "intercom_set_summary",
  "intercom_send",
  "intercom_ask",
  "intercom_pending",
  "intercom_reply"
]);
var MAX_TOOL_MESSAGES_PER_TURN = 8;
var MAX_TOOL_MESSAGES_PER_MINUTE = 30;
function formatMessage(from, message, agent) {
  const replyInstruction = message.expectsReply ? [
    "",
    "",
    "The sender is waiting for a blocking intercom reply.",
    "The coi sidecar will automatically send your final assistant message as the reply to this ask.",
    "Do not use intercom_reply or intercom_send to answer this ask; normal Codex MCP intercom tools run under a separate session identity and will not unblock the sender.",
    "If you need to acknowledge first, put the acknowledgement at the start of your final assistant message."
  ].join("\n") : "";
  const attachments = message.content.attachments?.map((attachment) => {
    const language = attachment.language ? ` (${attachment.language})` : "";
    return `

Attachment: ${attachment.name}${language}
${attachment.content}`;
  }).join("") ?? "";
  const custom = agent.instructions ? `

Agent instructions:
${agent.instructions}` : "";
  return [
    `Intercom message for ${agent.name}.`,
    `From: ${formatSessionDisplay(from)} (${from.id})`,
    `Message id: ${message.id}`,
    "",
    message.content.text,
    attachments,
    custom,
    replyInstruction
  ].join("\n");
}
function textInput(text) {
  return { type: "text", text, text_elements: [] };
}
function statusText(status) {
  if (!status || typeof status !== "object" || !("type" in status)) return "unknown";
  const type = status.type;
  return typeof type === "string" ? type : "unknown";
}
function getThreadId(result) {
  const thread = result && typeof result === "object" ? result.thread : void 0;
  if (!thread || typeof thread !== "object" || typeof thread.id !== "string") {
    throw new Error("Codex app-server response did not include thread.id");
  }
  return thread.id;
}
function threadSandboxMode(sandboxPolicy) {
  if (!sandboxPolicy || typeof sandboxPolicy !== "object" || Array.isArray(sandboxPolicy)) return "read-only";
  const type = sandboxPolicy.type;
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
function protectedBossClientForBridge(config) {
  assertBossCanonicalData(config, "$.bridgeConfig");
  if (!Array.isArray(config.agents)) return void 0;
  for (const agent of config.agents) {
    if (typeof agent !== "object" || agent === null || Array.isArray(agent)) continue;
    if (agent.bossClient === "boss_participant" || agent.bossClient === "boss_reviewer") return agent.bossClient;
  }
  return void 0;
}
function bridgeAgentSandboxMode(agent) {
  return agent.sandboxPolicy === void 0 ? bridgeAgentDefaultSandbox(agent) ?? "read-only" : threadSandboxMode(agent.sandboxPolicy);
}
function bridgeAgentTurnSandboxPolicy(agent) {
  if (agent.sandboxPolicy !== void 0) return agent.sandboxPolicy;
  if (bridgeAgentSandboxMode(agent) === "workspace-write") {
    throw new Error("workspace-write requires unavailable broker-owned assigned workspace authority");
  }
  return { type: "readOnly", networkAccess: false };
}
function getTurnId(result) {
  const turn = result && typeof result === "object" ? result.turn : void 0;
  if (!turn || typeof turn !== "object" || typeof turn.id !== "string") {
    throw new Error("Codex app-server response did not include turn.id");
  }
  return turn.id;
}
function getNotificationThreadId(params) {
  if (!params || typeof params !== "object") return null;
  const value = params.threadId;
  return typeof value === "string" ? value : null;
}
function getNotificationTurnId(params) {
  if (!params || typeof params !== "object") return null;
  const direct = params.turnId;
  if (typeof direct === "string") return direct;
  const turn = params.turn;
  if (turn && typeof turn === "object" && typeof turn.id === "string") {
    return turn.id;
  }
  return null;
}
function getCompletedAgentText(params) {
  if (!params || typeof params !== "object") return null;
  const item = params.item;
  if (!item || typeof item !== "object") return null;
  const raw = item;
  return raw.type === "agentMessage" && typeof raw.text === "string" ? raw.text : null;
}
function intercomSendFromArgs(rawArgs) {
  let args;
  try {
    args = parseToolArguments(rawArgs);
  } catch {
    return null;
  }
  return typeof args.to === "string" && typeof args.message === "string" ? { to: args.to, message: args.message } : null;
}
function getCompletedIntercomSend(params) {
  if (!params || typeof params !== "object") return null;
  const item = params.item;
  if (!isRecord2(item)) return null;
  const rawName = item.name ?? item.toolName ?? item.tool_name;
  if (typeof rawName !== "string" || normalizeToolName(rawName) !== "intercom_send") return null;
  return intercomSendFromArgs(item.arguments ?? item.args ?? item.input);
}
function getApprovedIntercomSend(params) {
  if (getApprovedIntercomToolFromApproval(params) !== "intercom_send") return null;
  if (!isRecord2(params)) return null;
  const meta = isRecord2(params._meta) ? params._meta : {};
  return intercomSendFromArgs(meta.tool_params ?? meta.toolParams ?? meta.tool_params_json);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function asOptionalPositiveInteger(value, name) {
  if (value === void 0) return void 0;
  return validateAskTimeoutMs(value, name);
}
function normalizeToolName(name) {
  const mcpMatch = name.match(/(?:^|__|\.)intercom_(whoami|status|list|set_summary|send|ask|pending|reply)$/);
  if (mcpMatch) return `intercom_${mcpMatch[1]}`;
  return name;
}
function parseToolArguments(value) {
  if (value === void 0 || value === null) return {};
  if (typeof value === "string") {
    const parsed = value.trim() ? JSON.parse(value) : {};
    if (!isRecord2(parsed)) throw new Error("tool arguments must be an object");
    return parsed;
  }
  if (!isRecord2(value)) throw new Error("tool arguments must be an object");
  return value;
}
function extractToolCall(message) {
  const params = isRecord2(message.params) ? message.params : {};
  const nested = ["toolCall", "tool", "call", "item"].map((key) => params[key]).find(isRecord2) ?? {};
  const rawName = params.name ?? params.toolName ?? params.tool_name ?? nested.name ?? nested.toolName ?? nested.tool_name;
  if (typeof rawName !== "string") throw new Error("item/tool/call did not include a tool name");
  const rawArgs = params.arguments ?? params.args ?? params.input ?? nested.arguments ?? nested.args ?? nested.input;
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  const turnId = typeof params.turnId === "string" ? params.turnId : null;
  return { threadId, turnId, name: normalizeToolName(rawName), args: parseToolArguments(rawArgs) };
}
function textToolResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...structuredContent ? { structuredContent } : {},
    ...isError ? { isError: true } : {}
  };
}
function appServerToolResponse(result) {
  return {
    success: !result.isError,
    contentItems: result.content,
    ...result.structuredContent ? { structuredContent: result.structuredContent } : {}
  };
}
var VirtualCodexAgent = class {
  constructor(agent, app, state, statePath, hooks = {}, options = {}, scopeId) {
    this.agent = agent;
    this.app = app;
    this.state = state;
    this.statePath = statePath;
    this.hooks = hooks;
    this.threadId = agent.threadId ?? state.agents[agent.id]?.threadId ?? null;
    this.scopeId = scopeId;
    this.client = options.client ?? new IntercomClient(scopeId ? { scopeId } : {});
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.reconnectDelays = options.reconnectDelays?.length ? options.reconnectDelays : [250, 500, 1e3, 2e3, 5e3];
  }
  agent;
  app;
  state;
  statePath;
  hooks;
  client;
  threadId;
  activeTurnId = null;
  waiters = /* @__PURE__ */ new Map();
  finalMessages = /* @__PURE__ */ new Map();
  toolReplyWaiters = /* @__PURE__ */ new Map();
  messageQueue = Promise.resolve();
  idleWaiters = [];
  turnCompletionWaiters = /* @__PURE__ */ new Map();
  toolMessageCountsByTurn = /* @__PURE__ */ new Map();
  toolMessageTimestamps = [];
  externalTurns = /* @__PURE__ */ new Map();
  connectPromise = null;
  reconnectTimer = null;
  reconnectAttempt = 0;
  reconnectEnabled = true;
  intercomStartedAt = Date.now();
  prepareConnection;
  reconnectDelays;
  scopeId;
  async start() {
    this.reconnectEnabled = true;
    this.client.on("message", (from, message, deliveryId) => {
      const routed = this.routeMessage(from, message);
      this.client.acknowledgeMessage(deliveryId);
      void routed.catch((error) => {
        this.client.updatePresence({ status: `error: ${error instanceof Error ? error.message : String(error)}` });
      });
    });
    this.client.on("error", (error) => {
      process.stderr.write(`intercom ${this.agent.id}: ${error.message}
`);
    });
    this.client.on("disconnected", (error) => {
      this.rejectAllToolReplies(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      this.scheduleReconnect();
    });
    await this.connectIntercom();
  }
  async connectIntercom() {
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
        status: this.threadId ? "idle" : "idle:no-thread"
      }, this.agent.id);
      this.reconnectAttempt = 0;
    })();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }
  scheduleReconnect() {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay3 = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectIntercom().then(() => {
        if (!this.client.isConnected()) {
          this.reconnectAttempt += 1;
          this.scheduleReconnect();
        }
      }).catch((error) => {
        this.reconnectAttempt += 1;
        process.stderr.write(`intercom ${this.agent.id}: reconnect failed: ${error instanceof Error ? error.message : String(error)}
`);
        this.scheduleReconnect();
      });
    }, delay3);
    this.reconnectTimer.unref?.();
  }
  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  rejectAllToolReplies(error) {
    for (const [replyTo, waiter] of Array.from(this.toolReplyWaiters.entries())) {
      clearTimeout(waiter.timeout);
      waiter.cleanup?.();
      this.toolReplyWaiters.delete(replyTo);
      waiter.reject(error);
    }
  }
  async stop() {
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
      }
    }
    await this.client.disconnect();
  }
  get id() {
    return this.agent.id;
  }
  async getContactTarget() {
    return resolveContactTarget(this.agent.id, this.agent.name, () => this.client.listSessions());
  }
  ownsThread(threadId) {
    return this.threadId === threadId;
  }
  onNotification(message) {
    const threadId = getNotificationThreadId(message.params);
    if (!threadId || threadId !== this.threadId) return;
    if (message.method === "error") {
      const params = isRecord2(message.params) ? message.params : {};
      const detail = isRecord2(params.error) && typeof params.error.message === "string" ? params.error.message : "Codex turn error";
      const willRetry = params.willRetry === true;
      this.client.updatePresence({ status: willRetry ? `reconnecting: ${detail}` : `error: ${detail}` });
      process.stderr.write(`codex ${this.agent.id}: ${detail}${willRetry ? "; app-server is retrying" : ""}
`);
      return;
    }
    if (message.method === "turn/started") {
      this.activeTurnId = getNotificationTurnId(message.params);
      this.client.updatePresence({ status: "active" });
      return;
    }
    if (message.method === "thread/status/changed" && message.params && typeof message.params === "object") {
      const status = statusText(message.params.status);
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
          process.stderr.write(`reply failed for ${this.agent.id} after intercom_send: ${error instanceof Error ? error.message : String(error)}
`);
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
      for (const resolve5 of idleWaiters) resolve5();
      void this.finishTurn(turnId);
    }
  }
  async ensureThread() {
    if (this.threadId) {
      try {
        const sandbox2 = bridgeAgentSandboxMode(this.agent);
        await this.app.request("thread/resume", {
          threadId: this.threadId,
          cwd: this.agent.cwd,
          model: this.agent.model ?? null,
          approvalPolicy: bridgeAgentApprovalPolicy(this.agent),
          sandbox: sandbox2
        });
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
      developerInstructions: this.agent.instructions ?? null,
      threadSource: "cli"
    });
    this.threadId = getThreadId(result);
    this.state.agents[this.agent.id] = { threadId: this.threadId, updatedAt: Date.now() };
    saveBridgeState(this.statePath, this.state);
    await this.app.request("thread/name/set", { threadId: this.threadId, name: this.agent.name }).catch(() => void 0);
    this.client.updatePresence({ status: "idle" });
    return this.threadId;
  }
  routeMessage(from, message) {
    const toolWaiter = this.toolReplyWaiters.get(message.replyTo ?? "");
    if (toolWaiter) {
      if (from.id === toolWaiter.from) {
        this.toolReplyWaiters.delete(message.replyTo ?? "");
        clearTimeout(toolWaiter.timeout);
        toolWaiter.cleanup?.();
        toolWaiter.resolve(message);
        return Promise.resolve();
      }
    }
    const run = this.messageQueue.catch(() => void 0).then(() => this.handleMessage(from, message));
    this.messageQueue = run.catch((error) => {
      this.client.updatePresence({ status: `error: ${error instanceof Error ? error.message : String(error)}` });
    });
    return run;
  }
  async handleMessage(from, message) {
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
  startTurn(threadId, input) {
    this.client.updatePresence({ status: "active" });
    return this.app.request("turn/start", {
      threadId,
      input,
      cwd: this.agent.cwd,
      approvalPolicy: bridgeAgentApprovalPolicy(this.agent),
      sandboxPolicy: bridgeAgentTurnSandboxPolicy(this.agent),
      model: this.agent.model ?? null
    });
  }
  async replyToWaiters(turnId) {
    const waiters = this.waiters.get(turnId);
    if (!waiters?.length) return;
    this.waiters.delete(turnId);
    const reply = this.finalMessages.get(turnId)?.trim() || "Codex turn completed without a final message.";
    for (const waiter of waiters) {
      await this.client.send(waiter.from.id, { text: reply, replyTo: waiter.message.id }).catch((error) => {
        process.stderr.write(`reply failed for ${this.agent.id}: ${error instanceof Error ? error.message : String(error)}
`);
      });
    }
  }
  async replyToWaitersFromIntercomSend(turnId, send) {
    const waiters = this.waiters.get(turnId);
    if (!waiters?.length) return;
    const lowerTo = send.to.toLowerCase();
    const remaining = [];
    for (const waiter of waiters) {
      const matchesSender = send.to === waiter.from.id || waiter.from.id.startsWith(send.to) || waiter.from.name?.toLowerCase() === lowerTo;
      if (!matchesSender) {
        remaining.push(waiter);
        continue;
      }
      await this.client.send(waiter.from.id, { text: send.message, replyTo: waiter.message.id }).catch((error) => {
        remaining.push(waiter);
        process.stderr.write(`reply failed for ${this.agent.id}: ${error instanceof Error ? error.message : String(error)}
`);
      });
    }
    if (remaining.length) {
      this.waiters.set(turnId, remaining);
    } else {
      this.waiters.delete(turnId);
    }
  }
  waitUntilIdle() {
    if (!this.activeTurnId) return Promise.resolve();
    return new Promise((resolve5) => {
      this.idleWaiters.push(resolve5);
    });
  }
  waitForTurnCompletion(turnId) {
    return new Promise((resolve5) => {
      const waiters = this.turnCompletionWaiters.get(turnId) ?? [];
      waiters.push(resolve5);
      this.turnCompletionWaiters.set(turnId, waiters);
    });
  }
  async finishTurn(turnId) {
    try {
      await this.replyToWaiters(turnId);
      const external = this.externalTurns.get(turnId);
      if (external && this.threadId) {
        this.hooks.onExternalTurnComplete?.({
          agentId: this.agent.id,
          threadId: this.threadId,
          from: external.from,
          message: external.message,
          response: this.finalMessages.get(turnId)?.trim() || "Codex turn completed without a final message."
        });
      }
    } finally {
      this.externalTurns.delete(turnId);
      this.finalMessages.delete(turnId);
      this.waiters.delete(turnId);
      this.toolMessageCountsByTurn.delete(turnId);
      const waiters = this.turnCompletionWaiters.get(turnId) ?? [];
      this.turnCompletionWaiters.delete(turnId);
      for (const resolve5 of waiters) resolve5();
    }
  }
  async handleToolCall(name, args, turnId, signal) {
    try {
      const result = await this.callIntercomTool(name, args, turnId, signal);
      return appServerToolResponse(result);
    } catch (error) {
      return appServerToolResponse(textToolResult(error instanceof Error ? error.message : String(error), { ok: false }, true));
    }
  }
  async callIntercomTool(name, args, turnId, signal) {
    switch (name) {
      case "intercom_whoami":
        return textToolResult(
          `session_id: ${this.agent.id}
name: ${this.agent.name}
cwd: ${this.agent.cwd}`,
          { session_id: this.agent.id, name: this.agent.name, cwd: this.agent.cwd, model: this.agent.model ?? "codex-app-server" }
        );
      case "intercom_team": {
        const sessions = await this.client.listSessions();
        const team = await resolveIntercomTeam({ selfId: this.agent.id, sessions });
        return textToolResult(formatIntercomTeam(team), team);
      }
      case "intercom_status": {
        const sessions = await this.client.listSessions();
        return textToolResult(
          `Connected: Yes
Session ID: ${this.agent.id}
Active sessions: ${sessions.length}`,
          { connected: true, session_id: this.agent.id, active_sessions: sessions.length }
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
        const result = await this.client.send(sendTo, { text: message });
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
        const questionId = randomUUID4();
        const replyPromise = this.waitForToolReply(sendTo, questionId, timeoutMs, signal);
        void replyPromise.catch(() => void 0);
        const result = await this.client.send(sendTo, { messageId: questionId, text: message, expectsReply: true });
        if (!result.delivered) {
          this.rejectToolReply(questionId, new Error(result.reason ?? "Session may not exist or has disconnected."));
          return textToolResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
        }
        const reply = await replyPromise;
        return textToolResult(`Reply from ${to}:
${reply.content.text}${formatAttachments(reply.content.attachments)}`, { ok: true, message_id: result.id, reply });
      }
      case "intercom_pending":
        return textToolResult("No unread messages.", { unread_messages: [], pending_asks: [] });
      case "intercom_reply":
        return textToolResult("No matching pending ask. App-server sidecar asks are answered automatically by final assistant messages.", { ok: false }, true);
      default:
        return textToolResult(`Unknown tool: ${name}`, { ok: false }, true);
    }
  }
  reserveToolMessage(turnId) {
    const now = Date.now();
    this.toolMessageTimestamps = this.toolMessageTimestamps.filter((timestamp) => now - timestamp < 6e4);
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
  async resolveTarget(to) {
    const sessions = await this.client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }
  waitForToolReply(from, replyTo, timeoutMs = DEFAULT_ASK_TIMEOUT_MS, signal) {
    return new Promise((resolve5, reject) => {
      if (signal?.aborted) {
        reject(new Error("intercom_ask cancelled"));
        return;
      }
      let timeout;
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
        reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1e3)} seconds`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.toolReplyWaiters.set(replyTo, { from, resolve: resolve5, reject, timeout, cleanup });
    });
  }
  rejectToolReply(replyTo, error) {
    const waiter = this.toolReplyWaiters.get(replyTo);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    waiter.cleanup?.();
    this.toolReplyWaiters.delete(replyTo);
    waiter.reject(error);
    void this.client.cancelAsk(replyTo);
  }
};
var CodexBridgeDaemon = class {
  constructor(config, hooks = {}, scopeId) {
    this.config = config;
    this.hooks = hooks;
    this.scopeId = scopeId;
    const protectedBossClient = protectedBossClientForBridge(config);
    assertHardenedBossProviderAuthority(protectedBossClient);
    assertHardenedBossBridgeConfig(config);
    for (const agent of config.agents) assertHardenedBossAgentConfig(agent);
    this.app = new CodexAppServerClient(config.appServer, protectedBossClient);
    this.app.setServerRequestHandler((message) => this.handleServerRequest(message));
  }
  config;
  hooks;
  scopeId;
  app;
  agents = [];
  inflightToolCalls = /* @__PURE__ */ new Map();
  async start() {
    assertHardenedBossProviderAuthority(protectedBossClientForBridge(this.config));
    assertHardenedBossBridgeConfig(this.config);
    for (const agent of this.config.agents) assertHardenedBossAgentConfig(agent);
    const intercomConfig = loadConfig();
    await spawnBrokerIfNeeded(intercomConfig.brokerCommand, intercomConfig.brokerArgs);
    await this.app.connect();
    const state = loadBridgeState(this.config.statePath);
    this.app.on("notification", (message) => {
      if (message.method === "notifications/cancelled" && message.params && typeof message.params === "object") {
        const requestId = message.params.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          this.inflightToolCalls.get(requestId)?.abort();
        }
      }
      for (const agent of this.agents) agent.onNotification(message);
    });
    this.agents = this.config.agents.map((agent) => new VirtualCodexAgent(agent, this.app, state, this.config.statePath, this.hooks, {}, this.scopeId));
    for (const agent of this.agents) await agent.start();
    process.stderr.write(`codex-intercom bridge running ${this.agents.length} virtual agent(s)
`);
  }
  async stop() {
    for (const agent of this.agents) await agent.stop().catch(() => void 0);
    await this.app.disconnect();
  }
  async ensureThreadForAgent(agentId) {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`No bridge agent registered with id: ${agentId}`);
    return agent.ensureThread();
  }
  async getContactTargetForAgent(agentId) {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`No bridge agent registered with id: ${agentId}`);
    return agent.getContactTarget();
  }
  async handleServerRequest(message) {
    if (message.method === "mcpServer/elicitation/request" && isIntercomToolApprovalRequest(message.params)) {
      const threadId = getNotificationThreadId(message.params);
      const turnId = getNotificationTurnId(message.params);
      const intercomSend = getApprovedIntercomSend(message.params);
      if (threadId && turnId && intercomSend) {
        const agent2 = this.agents.find((candidate) => candidate.ownsThread(threadId));
        if (agent2) await agent2.replyToWaitersFromIntercomSend(turnId, intercomSend);
      }
      return { action: "accept", content: {}, _meta: null };
    }
    if (message.method !== "item/tool/call") {
      if (!message.method) throw new Error("Unsupported app-server request");
      return defaultServerRequestResponse(message.method);
    }
    const call = extractToolCall(message);
    const agent = call.threadId ? this.agents.find((candidate) => candidate.ownsThread(call.threadId)) : this.agents[0];
    if (!agent) return appServerToolResponse(textToolResult("No bridge agent owns this tool call.", { ok: false }, true));
    const requestId = message.id;
    const abortController = typeof requestId === "string" || typeof requestId === "number" ? new AbortController() : null;
    if (abortController && requestId !== void 0) this.inflightToolCalls.set(requestId, abortController);
    try {
      return await agent.handleToolCall(call.name, call.args, call.turnId, abortController?.signal);
    } finally {
      if (abortController && requestId !== void 0) this.inflightToolCalls.delete(requestId);
    }
  }
};
function isIntercomToolApprovalRequest(params) {
  if (!isRecord2(params)) return false;
  const meta = isRecord2(params._meta) ? params._meta : {};
  return params.serverName === "codex-intercom" && meta.codex_approval_kind === "mcp_tool_call" && Boolean(getApprovedIntercomToolFromApproval(params));
}
function getApprovedIntercomToolFromApproval(params) {
  if (!isRecord2(params)) return null;
  const meta = isRecord2(params._meta) ? params._meta : {};
  const candidates = [
    meta.tool,
    meta.toolName,
    meta.tool_name,
    meta.name,
    typeof params.message === "string" ? params.message.match(/tool "([^"]+)"/)?.[1] : void 0
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && APPROVED_INTERCOM_TOOLS.has(candidate)) return candidate;
  }
  return null;
}
async function main() {
  const configPath = process.argv.includes("--config") ? process.argv[process.argv.indexOf("--config") + 1] : void 0;
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
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
    process.exit(1);
  });
}

// codex/clipboard.ts
import { spawn as spawn3 } from "node:child_process";
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function runDetachedClipboardCommand(command, args, text, env, timeoutMs) {
  return new Promise((resolve5) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve5(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, error: `${command} did not start within ${timeoutMs}ms` }), timeoutMs);
    try {
      const proc = spawn3(command, args, { env, stdio: ["pipe", "ignore", "ignore"] });
      proc.once("error", (error) => finish({ ok: false, error: error.message }));
      proc.once("spawn", () => {
        proc.stdin.on("error", () => {
        });
        proc.stdin.end(text);
        proc.unref();
        finish({ ok: true, method: command });
      });
    } catch (error) {
      finish({ ok: false, error: errorMessage(error) });
    }
  });
}
function runClipboardCommand(command, args, text, env, timeoutMs) {
  if (command === "wl-copy") return runDetachedClipboardCommand(command, args, text, env, timeoutMs);
  return new Promise((resolve5) => {
    let settled = false;
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve5(result);
    };
    const timeout = setTimeout(() => {
      proc?.kill("SIGKILL");
      finish({ ok: false, error: `${command} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    let proc;
    try {
      proc = spawn3(command, args, { env, stdio: ["pipe", "ignore", "pipe"] });
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      proc.once("error", (error) => finish({ ok: false, error: error.message }));
      proc.once("close", (code) => {
        finish(code === 0 ? { ok: true, method: command } : { ok: false, error: stderr.trim() || `${command} exited ${code}` });
      });
      proc.stdin.on("error", (error) => finish({ ok: false, error: error.message }));
      proc.stdin.end(text);
    } catch (error) {
      finish({ ok: false, error: errorMessage(error) });
    }
  });
}
async function copyTextToClipboard(text, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 2e3;
  const candidates = [];
  if (platform === "darwin") candidates.push(["pbcopy", []]);
  else if (platform === "win32") candidates.push(["clip.exe", []]);
  else {
    if (env.WAYLAND_DISPLAY) candidates.push(["wl-copy", []]);
    if (env.DISPLAY) {
      candidates.push(["xclip", ["-selection", "clipboard"]]);
      candidates.push(["xsel", ["--clipboard", "--input"]]);
    }
    candidates.push(["clip.exe", []]);
  }
  let lastError = "No clipboard command available";
  for (const [command, args] of candidates) {
    const result = await runClipboardCommand(command, args, text, env, timeoutMs);
    if (result.ok) return result;
    lastError = result.error ?? lastError;
  }
  return { ok: false, error: lastError };
}
function buildOsc52Sequence(text, env = process.env) {
  const osc = `\x1B]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  return env.TMUX ? `\x1BPtmux;\x1B${osc}\x1B\\` : osc;
}
function copyTextToTerminalClipboard(text, write, env = process.env) {
  try {
    write(buildOsc52Sequence(text, env));
    return { ok: true, method: "osc52" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// codex/tui-input.ts
import { StringDecoder } from "node:string_decoder";
var ESC = "\x1B";
var ALT_MODIFIER_BIT = 2;
var LOCK_MODIFIER_BITS = 192;
var DISALLOWED_MODIFIER_BITS = 61;
var KEY_I = 105;
var KEY_M = 109;
function parseNumber(value) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function isAltOnlyModifier(encodedModifier) {
  const bits = encodedModifier - 1;
  if (bits < 0 || (bits & ALT_MODIFIER_BIT) === 0) return false;
  return (bits & DISALLOWED_MODIFIER_BITS) === 0 && (bits & ~(ALT_MODIFIER_BIT | LOCK_MODIFIER_BITS)) === 0;
}
function matchKittyAltKey(sequence, key) {
  if (!sequence.endsWith("u")) return { consume: false, trigger: false };
  const params = sequence.slice(2, -1).split(";");
  if (params.length < 2) return { consume: false, trigger: false };
  const keyParts = params[0].split(":");
  const primaryKey = parseNumber(keyParts[0]);
  const baseLayoutKey = parseNumber(keyParts[2]);
  const modifierParts = params[1].split(":");
  const modifier = parseNumber(modifierParts[0]);
  const eventType = modifierParts[1] === void 0 ? 1 : parseNumber(modifierParts[1]);
  if (modifier === null || eventType === null || !isAltOnlyModifier(modifier)) {
    return { consume: false, trigger: false };
  }
  if (primaryKey !== key && baseLayoutKey !== key) {
    return { consume: false, trigger: false };
  }
  return { consume: true, trigger: eventType === 1 };
}
function matchModifyOtherKeysAltKey(sequence, expectedKey) {
  if (!sequence.endsWith("~")) return { consume: false, trigger: false };
  const params = sequence.slice(2, -1).split(";");
  if (params.length !== 3 || params[0] !== "27") return { consume: false, trigger: false };
  const modifier = parseNumber(params[1]);
  const key = parseNumber(params[2]);
  const matches = modifier !== null && key === expectedKey && isAltOnlyModifier(modifier);
  return { consume: matches, trigger: matches };
}
function matchAltKeySequence(sequence, key) {
  if (sequence === `${ESC}${String.fromCharCode(key)}`) return { consume: true, trigger: true };
  if (!sequence.startsWith(`${ESC}[`)) return { consume: false, trigger: false };
  if (sequence.endsWith("u")) return matchKittyAltKey(sequence, key);
  if (sequence.endsWith("~")) return matchModifyOtherKeysAltKey(sequence, key);
  return { consume: false, trigger: false };
}
function findCsiEnd(source, start) {
  for (let index = start + 2; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code >= 64 && code <= 126) return index;
  }
  return -1;
}
function filterAltIInput(input, pending = "") {
  const source = pending + input;
  let forwarded = "";
  let altICount = 0;
  let altMCount = 0;
  let index = 0;
  while (index < source.length) {
    if (source[index] !== ESC) {
      forwarded += source[index];
      index += 1;
      continue;
    }
    if (index + 1 >= source.length) {
      return { forwarded, pending: source.slice(index), altICount, altMCount };
    }
    if (source[index + 1] === "i") {
      altICount += 1;
      index += 2;
      continue;
    }
    if (source[index + 1] === "m") {
      altMCount += 1;
      index += 2;
      continue;
    }
    if (source[index + 1] !== "[") {
      forwarded += source[index];
      index += 1;
      continue;
    }
    const end = findCsiEnd(source, index);
    if (end === -1) {
      return { forwarded, pending: source.slice(index), altICount, altMCount };
    }
    const sequence = source.slice(index, end + 1);
    const altI = matchAltKeySequence(sequence, KEY_I);
    const altM = matchAltKeySequence(sequence, KEY_M);
    if (altI.consume || altM.consume) {
      if (altI.trigger) altICount += 1;
      if (altM.trigger) altMCount += 1;
    } else {
      forwarded += sequence;
    }
    index = end + 1;
  }
  return { forwarded, pending: "", altICount, altMCount };
}
var TuiInputDecoder = class {
  utf8 = new StringDecoder("utf8");
  pending = "";
  write(chunk) {
    const text = typeof chunk === "string" ? chunk : this.utf8.write(chunk);
    const filtered = filterAltIInput(text, this.pending);
    this.pending = filtered.pending;
    return { forwarded: filtered.forwarded, altICount: filtered.altICount, altMCount: filtered.altMCount };
  }
  hasPendingEscape() {
    return this.pending.length > 0;
  }
  flushPendingEscape() {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }
  end() {
    const filtered = filterAltIInput(this.utf8.end(), this.pending);
    this.pending = "";
    return {
      forwarded: filtered.forwarded + filtered.pending,
      altICount: filtered.altICount,
      altMCount: filtered.altMCount
    };
  }
};

// codex/coi.ts
var CODEX_OPTIONS_WITH_VALUE = /* @__PURE__ */ new Set([
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
  "--local-provider"
]);
var COI_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var MANAGED_MCP_ENV_KEYS = [
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
  "AGENT_INTERCOM_AGENT_DIR"
];
function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "codex";
}
function shortHash(value) {
  return createHash4("sha1").update(value).digest("hex").slice(0, 8);
}
function gitString(cwd, args) {
  const result = spawnSync2("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed || null;
}
function createDefaultIdentity(input) {
  const root = input.gitRoot || input.cwd;
  const repo = basename2(root) || "codex";
  const branch = input.branch || "worktree";
  const readable = `${repo}:${branch}`;
  const suffix = `${shortHash(input.cwd)}-${input.pid}`;
  return {
    id: sanitizeSegment(`codex-${repo}-${branch}-${suffix}`),
    name: `codex:${readable}#${input.pid}`
  };
}
function detectIdentity(cwd) {
  return createDefaultIdentity({
    cwd,
    pid: process.pid,
    gitRoot: gitString(cwd, ["rev-parse", "--show-toplevel"]),
    branch: gitString(cwd, ["branch", "--show-current"])
  });
}
function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}
function envFlagEnabled(value, defaultValue) {
  if (value === void 0) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return defaultValue;
}
function camelSandboxType(mode) {
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
function readCodexFlagValue(args, index, option) {
  const arg = args[index];
  const inline = arg.includes("=") ? arg.split(/=(.*)/s, 2)[1] : void 0;
  if (inline !== void 0) return { value: inline, nextIndex: index };
  return { value: readValue(args, index, option), nextIndex: index + 1 };
}
function deriveBridgeAgentRuntimeConfig(args, cwd) {
  let approvalPolicy;
  let sandboxMode;
  const writableRoots = /* @__PURE__ */ new Set([resolve4(cwd)]);
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
        writableRoots.add(resolve4(cwd, parsed.value));
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
  const sandboxType2 = sandboxMode ? camelSandboxType(sandboxMode) : void 0;
  const sandboxPolicy = sandboxType2 === "workspaceWrite" ? { type: sandboxType2, writableRoots: [...writableRoots], networkAccess: false } : sandboxType2 ? { type: sandboxType2, ...sandboxType2 === "readOnly" ? { networkAccess: false } : {} } : void 0;
  return {
    ...approvalPolicy ? { approvalPolicy } : {},
    ...sandboxPolicy ? { sandboxPolicy } : {}
  };
}
var HARDENED_BOSS_RAW_CONFIG_OPTIONS = /* @__PURE__ */ new Set(["-c", "--config", "-p", "--profile", "--enable", "--disable"]);
var HARDENED_BOSS_BYPASS_OPTIONS = /* @__PURE__ */ new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo"
]);
function isHardenedBossRawConfigOption(optionName) {
  return HARDENED_BOSS_RAW_CONFIG_OPTIONS.has(optionName) || optionName.startsWith("-c") && optionName !== "-C" || optionName.startsWith("-p");
}
function hardenedBossAttachedAuthorityOption(arg) {
  if (arg.length <= 2) return void 0;
  const option = arg.slice(0, 2);
  return option === "-s" || option === "-a" || option === "-C" ? option : void 0;
}
function assertHardenedBossCoiLaunch(args, cwd, bossClient) {
  if (bossClient !== void 0) {
    assertBossCanonicalData(args, "$.argv");
    if (!Array.isArray(args) || nodeUtilTypes4.isProxy(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error(`${bossClient} arguments must be a plain dense string array`);
    }
  }
  if (bossClient === void 0) return deriveBridgeAgentRuntimeConfig(args, cwd);
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
    if (attachedAuthorityOption !== void 0) {
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
  const probe = {
    id: "launch-validation",
    name: "launch-validation",
    cwd: resolve4(cwd),
    bossClient,
    ...runtime
  };
  assertHardenedBossAgentConfig(probe);
  return runtime;
}
function parseCoiArgs(argv, env = process.env) {
  const codexArgs = [];
  const options = {};
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
    const [key, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, void 0];
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
        options.cwd = resolve4(value ?? readValue(argv, index++, key));
        break;
      case "--instructions":
      case "--intercom-instructions":
        options.instructions = value ?? readValue(argv, index++, key);
        break;
      case "--socket":
      case "--intercom-socket":
        options.socketPath = resolve4(value ?? readValue(argv, index++, key));
        break;
      case "--state":
      case "--intercom-state":
        options.statePath = resolve4(value ?? readValue(argv, index++, key));
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
    cwd: resolve4(options.cwd ?? env.CODEX_INTERCOM_CWD ?? process.cwd()),
    id: options.id ?? env.CODEX_INTERCOM_SESSION_ID,
    name: options.name ?? env.CODEX_INTERCOM_NAME,
    instructions: options.instructions ?? env.CODEX_INTERCOM_INSTRUCTIONS,
    socketPath: options.socketPath,
    statePath: options.statePath,
    noTui: options.noTui ?? false,
    copyShortcut: options.copyShortcut ?? envFlagEnabled(env.CODEX_INTERCOM_SHORTCUT, true),
    codexCommand: env.CODEX_INTERCOM_CODEX_COMMAND || "codex",
    codexArgs
  };
}
function hasCodexHelpOrVersion(args) {
  return splitCodexResumeArgs(args).optionArgs.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V");
}
function splitCodexResumeArgs(args) {
  const optionArgs = [];
  const promptArgs = [];
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
function resolveCoiResumeRequest(args) {
  const { optionArgs, promptArgs, separatorPresent } = splitCodexResumeArgs(args);
  if (separatorPresent || promptArgs[0] !== "resume" || !promptArgs[1]) return { optionArgs, promptArgs };
  return { optionArgs, threadId: promptArgs[1], promptArgs: promptArgs.slice(2) };
}
function buildCoiTuiArgs(remote, optionArgs, threadId, promptArgs, explicitResume) {
  const promptTail = promptArgs.length === 0 ? [] : ["--", ...promptArgs];
  return explicitResume ? ["resume", "--remote", remote, ...optionArgs, threadId, ...promptTail] : ["--remote", remote, ...optionArgs, ...promptTail];
}
function buildCodexAppServerArgs(args, socketPath, env = process.env) {
  const { optionArgs } = splitCodexResumeArgs(args);
  const appServerArgs = [];
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
async function waitForSocket(socketPath, proc, timeoutMs = 1e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Codex app-server exited before creating ${socketPath}`);
    }
    if (existsSync6(socketPath)) return;
    await delay2(50);
  }
  throw new Error(`Timed out waiting for Codex app-server socket: ${socketPath}`);
}
async function stopChild(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  await new Promise((resolve5) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve5();
    }, 2e3);
    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve5();
    });
    proc.kill("SIGTERM");
  });
}
function terminalNotification(message) {
  const safe = message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
  if (process.stdout.isTTY) process.stdout.write(`\x1B]9;${safe}\x1B\\`);
  else process.stderr.write(`${safe}
`);
}
async function runInteractiveTui(command, args, refreshArgs, cwd, onAltI, onAltM, installRefresh, protectedBossClient, launchEnv = process.env) {
  assertHardenedBossProviderAuthority(protectedBossClient);
  const runInherited = async () => {
    const tui2 = spawn4(command, args, { cwd, env: launchEnv, stdio: "inherit" });
    const [code, signal] = await once2(tui2, "exit");
    if (typeof code === "number") return code;
    return signal === "SIGINT" ? 130 : 1;
  };
  if (!onAltI && !onAltM || !process.stdin.isTTY || !process.stdout.isTTY) {
    return runInherited();
  }
  let nodePty;
  try {
    nodePty = await import("node-pty");
  } catch (error) {
    process.stderr.write(`coi: Alt+I unavailable because optional node-pty could not load: ${error instanceof Error ? error.message : String(error)}
`);
    return runInherited();
  }
  const tui = nodePty.spawn(command, args, {
    name: launchEnv.TERM || "xterm-256color",
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd,
    env: launchEnv
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
  let pendingTimer = null;
  const flushPending = () => {
    const pending = inputDecoder.flushPendingEscape();
    if (!pending) return;
    try {
      tui.write(pending);
    } catch {
    }
    pendingTimer = null;
  };
  const onInput = (chunk) => {
    if (pendingTimer) clearTimeout(pendingTimer);
    const filtered = inputDecoder.write(chunk);
    if (filtered.forwarded) tui.write(filtered.forwarded);
    const controls = {
      insertText(text) {
        const safe = text.replace(/\x1b/g, "");
        tui.write(`\x1B[200~${safe}\x1B[201~`);
      }
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
  let exitCode;
  try {
    exitCode = await new Promise((resolve5) => {
      tui.onExit(({ exitCode: exitCode2, signal }) => resolve5(exitCode2 ?? (signal === 2 ? 130 : 1)));
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
function cleanupOldCoiStateFiles(intercomDir, now = Date.now(), maxAgeMs = COI_STATE_MAX_AGE_MS) {
  let entries;
  try {
    entries = readdirSync(intercomDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^coi-.+-state\.json$/.test(entry)) continue;
    const path = join8(intercomDir, entry);
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs > maxAgeMs) rmSync(path, { force: true });
    } catch {
    }
  }
}
function resetCoiStateForFreshStart(statePath, fresh) {
  if (fresh) rmSync(statePath, { force: true });
}
async function runCoi(options, env = process.env) {
  const scopeId = intercomScopeIdFromEnv(env);
  const bossClient = parseHardenedBossClientKind(env.CODEX_INTERCOM_BOSS_CLIENT?.trim(), "CODEX_INTERCOM_BOSS_CLIENT");
  assertHardenedBossProviderAuthority(bossClient);
  if (bossClient !== void 0 && options.codexCommand !== "codex") {
    throw new Error(`${bossClient} cannot use a caller-provided Codex/app-server command`);
  }
  const runtimeConfig = assertHardenedBossCoiLaunch(options.codexArgs, options.cwd, bossClient);
  if (hasCodexHelpOrVersion(options.codexArgs)) {
    const help = spawn4(options.codexCommand, options.codexArgs, {
      cwd: options.cwd,
      env,
      stdio: "inherit"
    });
    const [code, signal] = await once2(help, "exit");
    if (typeof code === "number") return code;
    return signal === "SIGINT" ? 130 : 1;
  }
  ensureIntercomRuntimeDir();
  const identity = detectIdentity(options.cwd);
  const id = sanitizeSegment(options.id ?? identity.id);
  const name = options.name ?? identity.name;
  const intercomDir = getIntercomDirPath();
  cleanupOldCoiStateFiles(intercomDir);
  const socketPath = options.socketPath ?? join8(intercomDir, `coi-${process.pid}.sock`);
  const statePath = options.statePath ?? join8(intercomDir, `coi-${sanitizeSegment(id)}-state.json`);
  const fresh = env.AGENT_INTERCOM_FRESH === "1";
  resetCoiStateForFreshStart(statePath, fresh);
  rmSync(socketPath, { force: true });
  const resumeRequest = resolveCoiResumeRequest(options.codexArgs);
  const agent = {
    id,
    name,
    cwd: options.cwd,
    model: env.CODEX_INTERCOM_MODEL,
    instructions: options.instructions,
    threadId: fresh ? void 0 : resumeRequest.threadId,
    ...bossClient === void 0 ? {} : { bossClient },
    ...runtimeConfig
  };
  assertHardenedBossAgentConfig(agent);
  const appServer = spawn4(options.codexCommand, buildCodexAppServerArgs(options.codexArgs, socketPath, env), {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  appServer.stderr?.on("data", (chunk) => {
    if (env.CODEX_INTERCOM_DEBUG) process.stderr.write(String(chunk));
  });
  const cleanup = async () => {
    await daemon?.stop().catch(() => void 0);
    await stopChild(appServer);
    rmSync(socketPath, { force: true });
  };
  let daemon = null;
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
  const config = {
    statePath,
    appServer: {
      transport: "unix-websocket",
      socketPath
    },
    agents: [agent]
  };
  let refreshVisibleTui;
  daemon = new CodexBridgeDaemon(config, {
    onExternalTurnComplete: ({ from, response }) => {
      terminalNotification(`Intercom turn from ${from.name || from.id} completed: ${response}`);
      setTimeout(() => refreshVisibleTui?.(), 1e3).unref();
    }
  }, scopeId);
  await daemon.start();
  process.stderr.write(`coi intercom session: ${name} (${id})
`);
  if (options.noTui) {
    await Promise.race([once2(process, "SIGINT"), once2(process, "SIGTERM"), once2(appServer, "exit")]);
    await cleanupOnce();
    return 0;
  }
  const remote = `unix://${socketPath}`;
  const threadId = await daemon.ensureThreadForAgent(id);
  const { optionArgs, promptArgs } = resumeRequest;
  process.stderr.write(`coi sidecar thread: ${threadId}
`);
  const resolvedTuiArgs = buildCoiTuiArgs(
    remote,
    optionArgs,
    threadId,
    promptArgs,
    Boolean(resumeRequest.threadId) && !fresh
  );
  const refreshTuiArgs = ["resume", "--remote", remote, ...optionArgs, threadId];
  let copying = false;
  const copyCurrentContact = (controls) => {
    if (copying) return;
    copying = true;
    void daemon.getContactTargetForAgent(id).then(async (contact) => {
      const instruction = formatContactInstruction(contact);
      const preferTerminal = Boolean(env.SSH_TTY || env.SSH_CONNECTION);
      let copied = preferTerminal ? copyTextToTerminalClipboard(instruction, (sequence) => process.stdout.write(sequence)) : await copyTextToClipboard(instruction);
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
    }).catch((error) => terminalNotification(`Failed to read intercom contact: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
      copying = false;
    });
  };
  const openIntercom = (controls) => {
    controls.insertText("Use intercom_list to show the active sessions, then ask me which session to message and what to send. Use intercom_send after I choose.");
    terminalNotification("Inserted intercom session picker request");
  };
  try {
    return await runInteractiveTui(
      options.codexCommand,
      resolvedTuiArgs,
      refreshTuiArgs,
      options.cwd,
      options.copyShortcut ? copyCurrentContact : void 0,
      options.copyShortcut ? openIntercom : void 0,
      (refresh) => {
        refreshVisibleTui = refresh;
        return () => {
          if (refreshVisibleTui === refresh) refreshVisibleTui = void 0;
        };
      },
      bossClient,
      env
    );
  } finally {
    await cleanupOnce();
  }
}
async function main2() {
  const options = parseCoiArgs(process.argv.slice(2));
  const code = await runCoi(options);
  process.exit(code);
}
if (process.argv[1] && (basename2(process.argv[1]) === "coi.ts" || basename2(process.argv[1]) === "coi.mjs")) {
  void main2().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
    process.exit(1);
  });
}
export {
  assertHardenedBossCoiLaunch,
  buildCodexAppServerArgs,
  buildCoiTuiArgs,
  cleanupOldCoiStateFiles,
  createDefaultIdentity,
  deriveBridgeAgentRuntimeConfig,
  hasCodexHelpOrVersion,
  parseCoiArgs,
  resetCoiStateForFreshStart,
  resolveCoiResumeRequest,
  runCoi,
  runInteractiveTui,
  sanitizeSegment,
  splitCodexResumeArgs
};
