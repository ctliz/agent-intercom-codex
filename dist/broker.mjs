process.stderr.write("[agent-intercom-build] package=@ctliz/agent-intercom-codex version=0.12.0-connect.6 target=broker sourceSha256=2f84f8a3fd8f97cb77cd03bc8a036c0ec90bfe1c67d3750a707f8814dcaf6c21\n");

// broker/broker.ts
import net from "net";
import { existsSync as existsSync3, readFileSync as readFileSync5, renameSync as renameSync3, writeFileSync as writeFileSync3, unlinkSync as unlinkSync2 } from "fs";
import { join as join2 } from "path";
import { randomUUID as randomUUID3 } from "crypto";
import { types as nodeUtilTypes2 } from "node:util";
import { authorize, POLICY_SEMANTICS_HASH, POLICY_SEMANTICS_VERSION } from "@ctliz/agent-intercom-core";
import { canonicalHash } from "@ctliz/agent-intercom-core/canonical";

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
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  INTERCOM_PROTOCOL_V4_VECTORS,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_SCOPE_ENV,
  INTERCOM_SCOPE_ID_PATTERN,
  INTERCOM_SCOPE_ID_PATTERN_SOURCE,
  intercomScopeIdFromEnv,
  parseIntercomScopeId,
  sameIntercomScope
} from "@ctliz/agent-intercom-core/protocol-v4";

// broker/paths.ts
import { chmodSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";
var INTERCOM_DIR_MODE = 448;
var INTERCOM_RUNTIME_FILE_MODE = 384;
var INTERCOM_TCP_HOST = "127.0.0.1";
var INTERCOM_PROTOCOL_NAME2 = "pi-intercom";
var INTERCOM_PROTOCOL_VERSION2 = 4;
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
function getBrokerAskStateFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker-asks.json");
}
function getBrokerAccessStateFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker-access.json");
}
function getBrokerAdminCredentialFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker-admin.json");
}
function getBrokerAuditFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker-audit.jsonl");
}
function getRemoteGatewaySocketPath(platform = process.platform, agentDir = getAgentDirPath()) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-remote-${sanitizePipeSegment(agentDir)}`;
  }
  return join(getIntercomDirPath(agentDir), "remote-gateway.sock");
}
function getBrokerSocketPath(platform = process.platform, agentDir = getAgentDirPath()) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }
  return join(getIntercomDirPath(agentDir), "broker.sock");
}
function getBrokerListenTarget(platform = process.platform, env = process.env) {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    return { transport: "tcp", host: INTERCOM_TCP_HOST, port: 0 };
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

// config.ts
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
function getAskTimeoutMs() {
  const raw = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }
  const value = Number(raw);
  return validateAskTimeoutMs(value, "PI_INTERCOM_ASK_TIMEOUT_MS");
}

// durable-json.ts
import { randomUUID } from "crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
function writeDurableJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf-8", mode: INTERCOM_RUNTIME_FILE_MODE });
  const fileDescriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(temporaryPath, filePath);
  restrictIntercomRuntimeFile(filePath);
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(dirname(filePath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

// broker/ownership.ts
import { closeSync as closeSync2, constants, openSync as openSync2, readFileSync as readFileSync2, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
function ownerPid(path) {
  try {
    const pid = Number.parseInt(readFileSync2(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function acquireBrokerOwnership(path, pid = process.pid) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync2(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, INTERCOM_RUNTIME_FILE_MODE);
      try {
        writeFileSync2(fd, String(pid));
      } finally {
        closeSync2(fd);
      }
      restrictIntercomRuntimeFile(path);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existingPid = ownerPid(path);
      if (existingPid !== null && pidIsAlive(existingPid)) {
        throw new Error(`Intercom broker already owned by live process ${existingPid}`);
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire intercom broker ownership");
}
function releaseBrokerOwnership(path, pid = process.pid) {
  if (ownerPid(path) !== pid) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function hasBrokerOwnership(path, pid = process.pid) {
  return ownerPid(path) === pid;
}

// broker/access-registry.ts
import { createHash, randomBytes, randomUUID as randomUUID2, timingSafeEqual } from "crypto";
import { existsSync, readFileSync as readFileSync3 } from "fs";
var REMOTE_ACCESS_STATE_VERSION = 2;
var REMOTE_ACCESS_CREDENTIAL_VERSION = 1;
var DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1e3;
var DEFAULT_PRINCIPAL_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var RemoteAccessError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RemoteAccessError";
  }
  code;
};
function emptyState() {
  return { version: REMOTE_ACCESS_STATE_VERSION, principals: {}, enrollments: {} };
}
function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
function secretsMatch(secret, expectedHash) {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function newSecret() {
  return randomBytes(32).toString("base64url");
}
function requireText(value, field, maxLength = 512) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}
function boundedInteger(value, fallback, field, minimum, maximum) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new Error(`Invalid ${field}`);
  return resolved;
}
function parseState(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("expected object");
  const state = raw;
  if (state.version !== 1 && state.version !== REMOTE_ACCESS_STATE_VERSION) throw new Error("unsupported version");
  if (typeof state.principals !== "object" || state.principals === null || Array.isArray(state.principals)) throw new Error("invalid principals");
  if (typeof state.enrollments !== "object" || state.enrollments === null || Array.isArray(state.enrollments)) throw new Error("invalid enrollments");
  if (state.adminCredentialHash !== void 0 && typeof state.adminCredentialHash !== "string") throw new Error("invalid admin credential hash");
  const principals = {};
  for (const [id, value] of Object.entries(state.principals)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid principal ${id}`);
    const principal = value;
    if (principal.id !== id || typeof principal.name !== "string" || typeof principal.credentialHash !== "string" || typeof principal.parentSessionId !== "string" || typeof principal.rootSessionId !== "string" || typeof principal.remoteHostId !== "string" || typeof principal.generation !== "number" || principal.state !== "active" && principal.state !== "revoked" || typeof principal.expiresAt !== "number" || typeof principal.createdAt !== "number" || typeof principal.updatedAt !== "number") throw new Error(`invalid principal ${id}`);
    const depth = boundedInteger(principal.depth, 1, "principal depth", 1, 32);
    const maxDepth = boundedInteger(principal.maxDepth, depth, "maximum delegation depth", depth, 32);
    const maxChildren = boundedInteger(principal.maxChildren, 0, "maximum child count", 0, 128);
    principals[id] = {
      ...principal,
      policy: "remote-tree",
      canDelegate: principal.canDelegate === true,
      depth,
      maxDepth,
      maxChildren
    };
  }
  const enrollments = {};
  for (const [hash, value] of Object.entries(state.enrollments)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid enrollment ${hash}`);
    const enrollment = value;
    const template = enrollment.template;
    if (!template || typeof template !== "object") throw new Error(`invalid enrollment ${hash}`);
    const depth = boundedInteger(template.depth, 1, "enrollment depth", 1, 32);
    enrollments[hash] = {
      ...enrollment,
      template: {
        ...template,
        canDelegate: template.canDelegate === true,
        depth,
        maxDepth: boundedInteger(template.maxDepth, depth, "enrollment maximum depth", depth, 32),
        maxChildren: boundedInteger(template.maxChildren, 0, "enrollment maximum children", 0, 128)
      }
    };
  }
  return {
    version: REMOTE_ACCESS_STATE_VERSION,
    ...typeof state.adminCredentialHash === "string" ? { adminCredentialHash: state.adminCredentialHash } : {},
    principals,
    enrollments
  };
}
var RemoteAccessRegistry = class {
  constructor(statePath, now = Date.now) {
    this.statePath = statePath;
    this.now = now;
    this.state = this.load();
  }
  statePath;
  now;
  state;
  snapshot() {
    return structuredClone(this.state);
  }
  ensureAdminCredential(credentialPath) {
    if (existsSync(credentialPath)) {
      const parsed = JSON.parse(readFileSync3(credentialPath, "utf8"));
      if (parsed.version === REMOTE_ACCESS_CREDENTIAL_VERSION && typeof parsed.adminToken === "string" && parsed.adminToken.length >= 32) {
        const hash = hashSecret(parsed.adminToken);
        if (this.state.adminCredentialHash !== hash) {
          this.state.adminCredentialHash = hash;
          this.persist();
        }
        restrictIntercomRuntimeFile(credentialPath);
        return parsed.adminToken;
      }
    }
    const adminToken = newSecret();
    writeDurableJson(credentialPath, { version: REMOTE_ACCESS_CREDENTIAL_VERSION, adminToken });
    this.state.adminCredentialHash = hashSecret(adminToken);
    this.persist();
    return adminToken;
  }
  authenticateAdmin(adminToken) {
    return typeof this.state.adminCredentialHash === "string" && secretsMatch(adminToken, this.state.adminCredentialHash);
  }
  issueEnrollment(template, ttlMs = DEFAULT_ENROLLMENT_TTL_MS) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1e3) throw new Error("Invalid enrollment TTL");
    const now = this.now();
    const enrollmentToken = newSecret();
    const tokenHash = hashSecret(enrollmentToken);
    const expiresAt = now + ttlMs;
    const principalExpiresAt = template.expiresAt ?? now + DEFAULT_PRINCIPAL_TTL_MS;
    if (!Number.isSafeInteger(principalExpiresAt) || principalExpiresAt <= now) throw new Error("Invalid principal expiry");
    const depth = boundedInteger(template.depth, 1, "principal depth", 1, 32);
    const maxDepth = boundedInteger(template.maxDepth, depth, "maximum delegation depth", depth, 32);
    const maxChildren = boundedInteger(template.maxChildren, 0, "maximum child count", 0, 128);
    const canDelegate = template.canDelegate === true;
    if (canDelegate && (maxDepth <= depth || maxChildren === 0)) throw new Error("Delegating principals require remaining depth and child capacity");
    const normalized = {
      name: requireText(template.name, "principal name", 256),
      parentSessionId: requireText(template.parentSessionId, "parent session ID"),
      rootSessionId: requireText(template.rootSessionId, "root session ID"),
      remoteHostId: requireText(template.remoteHostId, "remote host ID", 256),
      expiresAt: principalExpiresAt,
      canDelegate,
      depth,
      maxDepth,
      maxChildren
    };
    this.pruneExpiredEnrollments(now);
    this.state.enrollments[tokenHash] = { tokenHash, template: normalized, expiresAt, createdAt: now };
    this.persist();
    return { enrollmentToken, expiresAt };
  }
  issueChildEnrollment(parentSessionId, parentGeneration, request, ttlMs = DEFAULT_ENROLLMENT_TTL_MS) {
    const parent = this.validatePrincipal(parentSessionId, parentGeneration);
    if (!parent.canDelegate) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent principal cannot delegate children");
    const now = this.now();
    const activeChildren = Object.values(this.state.principals).filter(
      (principal) => principal.parentSessionId === parent.id && principal.state === "active" && principal.expiresAt > now
    ).length;
    const pendingChildren = Object.values(this.state.enrollments).filter(
      (enrollment) => enrollment.template.parentSessionId === parent.id && enrollment.expiresAt > now
    ).length;
    if (activeChildren + pendingChildren >= parent.maxChildren) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent child limit is exhausted");
    const depth = parent.depth + 1;
    if (depth > parent.maxDepth) throw new RemoteAccessError("INVALID_ENROLLMENT", "Parent delegation depth is exhausted");
    const maxDepth = boundedInteger(request.maxDepth, depth, "child maximum depth", depth, parent.maxDepth);
    const maxChildren = boundedInteger(request.maxChildren, 0, "child maximum count", 0, parent.maxChildren);
    const canDelegate = request.canDelegate === true;
    if (canDelegate && (maxDepth <= depth || maxChildren === 0)) throw new Error("Delegating child requires remaining depth and child capacity");
    const expiresAt = request.expiresAt ?? parent.expiresAt;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > parent.expiresAt) {
      throw new Error("Child expiry must not exceed the parent expiry");
    }
    return this.issueEnrollment({
      name: request.name,
      parentSessionId: parent.id,
      rootSessionId: parent.rootSessionId,
      remoteHostId: parent.remoteHostId,
      expiresAt,
      canDelegate,
      depth,
      maxDepth,
      maxChildren
    }, ttlMs);
  }
  consumeEnrollment(enrollmentToken) {
    const now = this.now();
    const tokenHash = hashSecret(enrollmentToken);
    const enrollment = this.state.enrollments[tokenHash];
    if (!enrollment) {
      console.error("DEBUG: Enrollment token not found, hash:", tokenHash);
      throw new RemoteAccessError("INVALID_ENROLLMENT", "Enrollment credential is invalid or already consumed");
    }
    console.error("DEBUG: Enrollment consumed, hash:", tokenHash);
    delete this.state.enrollments[tokenHash];
    if (enrollment.expiresAt <= now) {
      this.persist();
      throw new RemoteAccessError("INVALID_ENROLLMENT", "Enrollment credential has expired");
    }
    const sessionCredential = newSecret();
    const id = randomUUID2();
    const principal = {
      id,
      name: enrollment.template.name,
      credentialHash: hashSecret(sessionCredential),
      parentSessionId: enrollment.template.parentSessionId,
      rootSessionId: enrollment.template.rootSessionId,
      remoteHostId: enrollment.template.remoteHostId,
      generation: 1,
      policy: "remote-tree",
      canDelegate: enrollment.template.canDelegate === true,
      depth: enrollment.template.depth,
      maxDepth: enrollment.template.maxDepth,
      maxChildren: enrollment.template.maxChildren,
      state: "active",
      expiresAt: enrollment.template.expiresAt,
      createdAt: now,
      updatedAt: now
    };
    this.state.principals[id] = principal;
    this.persist();
    return { principal: structuredClone(principal), sessionCredential };
  }
  authenticateSession(sessionId, generation, sessionCredential) {
    const principal = this.state.principals[sessionId];
    if (!principal || !secretsMatch(sessionCredential, principal.credentialHash)) {
      throw new RemoteAccessError("INVALID_CREDENTIAL", "Session credential is invalid");
    }
    return this.validatePrincipal(sessionId, generation);
  }
  validatePrincipal(sessionId, generation) {
    const principal = this.state.principals[sessionId];
    if (!principal) throw new RemoteAccessError("INVALID_CREDENTIAL", "Remote principal does not exist");
    if (principal.state !== "active") throw new RemoteAccessError("REVOKED_CREDENTIAL", "Session credential is revoked");
    if (principal.expiresAt <= this.now()) throw new RemoteAccessError("EXPIRED_CREDENTIAL", "Session credential has expired");
    if (principal.generation !== generation) throw new RemoteAccessError("STALE_GENERATION", "Session credential generation is stale");
    return structuredClone(principal);
  }
  inspectSubtree(principalId) {
    const result = [];
    const queue = [principalId];
    const seen = /* @__PURE__ */ new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const principal = this.state.principals[id];
      if (!principal) continue;
      const { credentialHash: _credentialHash, ...metadata } = principal;
      result.push(structuredClone(metadata));
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    return result;
  }
  adoptSubtree(principalId, newParentSessionId, newRootSessionId) {
    const principal = this.state.principals[principalId];
    if (!principal) throw new Error("Unknown adopted principal");
    if (principalId === newParentSessionId) throw new Error("Adoption would create an ownership cycle");
    let ancestor = this.state.principals[newParentSessionId];
    const seen = /* @__PURE__ */ new Set();
    while (ancestor && !seen.has(ancestor.id)) {
      if (ancestor.id === principalId) throw new Error("Adoption would create an ownership cycle");
      seen.add(ancestor.id);
      ancestor = this.state.principals[ancestor.parentSessionId];
    }
    const ids = this.subtreePrincipalIds(principalId);
    const now = this.now();
    principal.parentSessionId = requireText(newParentSessionId, "new parent session ID");
    for (const id of ids) {
      const changed = this.state.principals[id];
      changed.rootSessionId = requireText(newRootSessionId, "new root session ID");
      changed.generation += 1;
      changed.updatedAt = now;
    }
    const changedIds = new Set(ids);
    for (const [hash, enrollment] of Object.entries(this.state.enrollments)) {
      if (changedIds.has(enrollment.template.parentSessionId)) delete this.state.enrollments[hash];
    }
    this.persist();
    return ids.map((id) => structuredClone(this.state.principals[id]));
  }
  expirePrincipals(now = this.now()) {
    const changed = /* @__PURE__ */ new Map();
    const expiredRoots = Object.values(this.state.principals).filter((principal) => principal.state === "active" && principal.expiresAt <= now).sort((left, right) => left.depth - right.depth);
    for (const principal of expiredRoots) {
      if (changed.has(principal.id)) continue;
      for (const revoked of this.revoke(principal.id)) changed.set(revoked.id, revoked);
    }
    return [...changed.values()];
  }
  revoke(principalId) {
    const now = this.now();
    const queue = [principalId];
    const seen = /* @__PURE__ */ new Set();
    const changed = [];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const principal = this.state.principals[id];
      if (!principal) continue;
      principal.state = "revoked";
      principal.generation += 1;
      principal.updatedAt = now;
      changed.push(structuredClone(principal));
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    if (changed.length) this.persist();
    return changed;
  }
  subtreePrincipalIds(principalId) {
    const result = [];
    const queue = [principalId];
    const seen = /* @__PURE__ */ new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id) || !this.state.principals[id]) continue;
      seen.add(id);
      result.push(id);
      for (const candidate of Object.values(this.state.principals)) {
        if (candidate.parentSessionId === id) queue.push(candidate.id);
      }
    }
    return result;
  }
  pruneExpiredEnrollments(now = this.now()) {
    for (const [hash, enrollment] of Object.entries(this.state.enrollments)) {
      if (enrollment.expiresAt <= now) delete this.state.enrollments[hash];
    }
  }
  load() {
    if (!existsSync(this.statePath)) return emptyState();
    try {
      return parseState(JSON.parse(readFileSync3(this.statePath, "utf8")));
    } catch (error) {
      throw new Error(`Invalid remote access registry at ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  persist() {
    writeDurableJson(this.statePath, this.state);
  }
};

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
function bossPrincipal(session, metadata) {
  const { binding } = metadata;
  return {
    version: BOSS_POLICY_PRINCIPAL_VERSION,
    principalId: session.id,
    principalClass: "boss-private",
    state: binding.state,
    bossRunId: binding.bossRunId,
    participantId: binding.participantId,
    role: binding.role,
    bindingEpoch: binding.bindingEpoch,
    ...binding.assignedManagerParticipantId === void 0 ? {} : { assignedManagerParticipantId: binding.assignedManagerParticipantId },
    ...metadata.assignedParticipantIds === void 0 ? {} : { assignedParticipantIds: metadata.assignedParticipantIds },
    ...metadata.requestingPrincipalId === void 0 ? {} : { requestingPrincipalId: metadata.requestingPrincipalId }
  };
}
function featurePolicyStateForSessions(sessions) {
  const legacy = { principals: {} };
  const boss = { principals: {} };
  const registrations = {};
  for (const session of sessions) {
    if (session.boss !== void 0) {
      const metadata = parseBossParticipantBindingMetadata(session.boss, session.id);
      boss.principals[session.id] = bossPrincipal(session, metadata);
      registrations[session.id] = {
        principalId: session.id,
        principalClass: "boss-bound",
        state: metadata.binding.state,
        bossRunId: metadata.binding.bossRunId,
        participantId: metadata.binding.participantId,
        bindingEpoch: metadata.binding.bindingEpoch,
        featureContract: metadata.featureContract,
        policySemanticsHash: BOSS_POLICY_SEMANTICS_HASH,
        capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
        brokerIdentityVerified: metadata.brokerIdentityVerified
      };
      continue;
    }
    const principal = session.origin === "remote" ? (() => {
      if (!session.parentSessionId || !session.rootSessionId || !session.generation) {
        throw new Error(`Remote session ${session.id} is missing broker-owned policy metadata`);
      }
      return {
        id: session.id,
        kind: "remote",
        state: "active",
        generation: session.generation,
        policy: "remote-tree",
        parentSessionId: session.parentSessionId,
        rootSessionId: session.rootSessionId
      };
    })() : {
      id: session.id,
      kind: "local",
      state: "active",
      generation: 1,
      policy: "local-public",
      rootSessionId: session.id
    };
    legacy.principals[session.id] = principal;
    registrations[session.id] = { principalId: session.id, principalClass: "ordinary", state: "active" };
  }
  return { legacy, boss, registrations };
}
function authorizeBossAwareSessionAction(sessions, actorId, action, targetId, bossContext) {
  const values = Array.from(sessions);
  const state = featurePolicyStateForSessions(values);
  const actor = state.registrations[actorId];
  const target = state.registrations[targetId];
  return authorizeFeatureAware(state, {
    actorId,
    action,
    targetId,
    ...actor?.principalClass === "ordinary" && target?.principalClass === "ordinary" ? {
      legacyContext: {
        actorGeneration: state.legacy.principals[actorId]?.generation,
        targetGeneration: state.legacy.principals[targetId]?.generation
      }
    } : bossContext === void 0 ? {} : { bossContext }
  });
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
function hasAuthoritativeBossControlCorrelation() {
  return false;
}
function exactBossSessionTarget(sessions, requestedSessionId) {
  const target = sessions.get(requestedSessionId);
  return target?.info.id === requestedSessionId ? target : void 0;
}
function assertBossControlSender(session, envelopeValue) {
  const { envelope } = bossControlKind(envelopeValue);
  if (session.boss === void 0) {
    throw new ContractValidationError("$.session", "ordinary sessions cannot originate Boss control envelopes");
  }
  const { binding } = parseBossParticipantBindingMetadata(session.boss, session.id);
  if (binding.state !== "active" || envelope.bossRunId !== binding.bossRunId || envelope.participantId !== binding.participantId || envelope.bindingEpoch !== binding.bindingEpoch) {
    throw new ContractValidationError("$.envelope", "does not match the active broker-owned participant binding");
  }
  return envelope;
}

// broker/authorization.ts
function authorizeSessionAction(sessions, actorId, action, targetId, bossContext) {
  return authorizeBossAwareSessionAction(sessions, actorId, action, targetId, bossContext);
}
function visibleSessions(sessions, actorId) {
  const values = Array.from(sessions);
  return values.filter((target) => authorizeSessionAction(values, actorId, "discover", target.id).allowed);
}

// broker/audit.ts
import { closeSync as closeSync3, fsyncSync as fsyncSync2, openSync as openSync3, writeSync } from "fs";
var BROKER_AUDIT_VERSION = 1;
var BrokerAuditLog = class {
  constructor(path, now = Date.now) {
    this.path = path;
    this.now = now;
  }
  path;
  now;
  record(entry) {
    const line = `${JSON.stringify({
      version: BROKER_AUDIT_VERSION,
      timestamp: this.now(),
      ...entry
    })}
`;
    const descriptor = openSync3(this.path, "a", INTERCOM_RUNTIME_FILE_MODE);
    try {
      writeSync(descriptor, line, void 0, "utf8");
      fsyncSync2(descriptor);
    } finally {
      closeSync3(descriptor);
    }
    restrictIntercomRuntimeFile(this.path);
  }
  tryRecord(entry) {
    try {
      this.record(entry);
    } catch (error) {
      console.error("Failed to append Agent Intercom broker audit event:", error);
    }
  }
};

// broker/boss-control-ledger.ts
import { existsSync as existsSync2, readFileSync as readFileSync4, renameSync as renameSync2 } from "node:fs";
import { canonicalJson as canonicalJson2 } from "@ctliz/agent-intercom-core/canonical";
var BOSS_CONTROL_LEDGER_VERSION = 3;
var EXPIRING_BOSS_CONTROL_LEDGER_VERSION = 2;
var MAX_BOSS_CONTROL_RESULTS = 2048;
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
function rebindBossControlResult(resultValue, messageId) {
  if (typeof messageId !== "string" || messageId.length === 0) throw new Error("Replay messageId is required");
  const result = parseBossControlResult(resultValue);
  return parseBossControlResult({ ...result, requestId: messageId, messageId });
}
function bossControlReplayFrames(resultValue, messageId) {
  const result = rebindBossControlResult(resultValue, messageId);
  if (result.deliveryId === void 0) return [result];
  return [{
    type: "boss_control_ack",
    requestId: messageId,
    messageId,
    idempotencyKey: result.idempotencyKey,
    status: "accepted",
    deliveryId: result.deliveryId
  }, result];
}
function bossControlAcceptedRecoveryFrames(resultValue) {
  const result = parseBossControlResult(resultValue);
  if (result.status !== "rejected" || result.deliveryId === void 0) {
    throw new Error("Accepted Boss recovery requires a delivery-bound rejected result");
  }
  return [{
    type: "boss_control_ack",
    requestId: result.requestId,
    messageId: result.messageId,
    idempotencyKey: result.idempotencyKey,
    status: "accepted",
    deliveryId: result.deliveryId
  }, result];
}
function parseHash(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid Boss ledger ${field}`);
  return value;
}
function parseEntry(value, version) {
  assertBossCanonicalData(value, "$.entries[]");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Boss ledger entry");
  const entry = value;
  const legacyExpiry = version === EXPIRING_BOSS_CONTROL_LEDGER_VERSION;
  if (legacyExpiry && (typeof entry.expiresAt !== "number" || !Number.isSafeInteger(entry.expiresAt))) {
    throw new Error("Invalid Boss ledger expiry");
  }
  const base = {
    scope: parseHash(entry.scope, "scope"),
    fingerprint: parseHash(entry.fingerprint, "fingerprint")
  };
  const baseKeys = legacyExpiry ? ["scope", "fingerprint", "expiresAt", "state"] : ["scope", "fingerprint", "state"];
  if (entry.state === "accepted" && exactStringKeys(entry, [...baseKeys, "deliveryId"]) && typeof entry.deliveryId === "string" && entry.deliveryId.length > 0) return { ...base, state: "accepted", deliveryId: entry.deliveryId };
  if (entry.state === "terminal" && exactStringKeys(entry, [...baseKeys, "result"])) {
    return { ...base, state: "terminal", result: parseBossControlResult(entry.result) };
  }
  throw new Error("Invalid Boss ledger state discriminant");
}
var BossControlResultLedger = class {
  constructor(path, now = Date.now) {
    this.path = path;
    this.now = now;
    const loaded = this.load();
    this.state = loaded.state;
    if (loaded.migrated) this.persist();
  }
  path;
  now;
  state;
  lookup(scope, fingerprint) {
    const entry = this.state.entries.find((candidate) => candidate.scope === scope);
    if (!entry) return { status: "miss" };
    if (entry.fingerprint !== fingerprint) return { status: "conflict" };
    return entry.state === "accepted" ? { status: "accepted", deliveryId: entry.deliveryId } : { status: "replay", result: structuredClone(entry.result) };
  }
  recordAccepted(scope, fingerprint, deliveryId) {
    if (!/^[a-f0-9]{64}$/.test(scope) || !/^[a-f0-9]{64}$/.test(fingerprint) || !deliveryId) {
      throw new Error("Invalid Boss accepted-state binding");
    }
    const existing = this.state.entries.find((entry) => entry.scope === scope);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.state !== "accepted" || existing.deliveryId !== deliveryId) {
        throw new Error("Boss idempotency scope is already bound to a different canonical state");
      }
      return;
    }
    this.reserveCapacity();
    this.state.entries.push({ scope, fingerprint, state: "accepted", deliveryId });
    this.persist();
  }
  recordTerminal(scope, fingerprint, resultValue) {
    const result = parseBossControlResult(resultValue);
    canonicalJson2(result);
    const existing = this.state.entries.find((entry) => entry.scope === scope);
    if (existing?.fingerprint !== void 0 && existing.fingerprint !== fingerprint) {
      throw new Error("Boss idempotency scope is already bound to a different canonical request");
    }
    if (existing?.state === "terminal") {
      const existingStable = { ...existing.result, requestId: "<caller>", messageId: "<caller>" };
      const resultStable = { ...result, requestId: "<caller>", messageId: "<caller>" };
      if (canonicalJson2(existingStable) !== canonicalJson2(resultStable)) {
        throw new Error("Boss idempotency scope is already bound to a different canonical result");
      }
      return;
    }
    if (result.status === "delivered" || result.deliveryId !== void 0) {
      if (existing?.state !== "accepted" || existing.deliveryId !== result.deliveryId) {
        throw new Error("Boss terminal delivery requires the matching durable accepted state");
      }
    } else if (existing?.state === "accepted") {
      throw new Error("A terminal result after acceptance must carry the accepted deliveryId");
    }
    const terminal = {
      scope,
      fingerprint,
      state: "terminal",
      result
    };
    if (existing) this.state.entries[this.state.entries.indexOf(existing)] = terminal;
    else {
      this.reserveCapacity();
      this.state.entries.push(terminal);
    }
    this.persist();
  }
  reserveCapacity() {
    if (this.state.entries.length >= MAX_BOSS_CONTROL_RESULTS) {
      throw new Error("Durable Boss control ledger is full");
    }
  }
  load() {
    if (!existsSync2(this.path)) {
      return { state: { version: BOSS_CONTROL_LEDGER_VERSION, entries: [] }, migrated: false };
    }
    try {
      const parsed = JSON.parse(readFileSync4(this.path, "utf8"));
      assertBossCanonicalData(parsed, "$.bossControlLedger");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed;
      if (!exactStringKeys(state, ["version", "entries"]) || state.version !== BOSS_CONTROL_LEDGER_VERSION && state.version !== EXPIRING_BOSS_CONTROL_LEDGER_VERSION || !Array.isArray(state.entries)) throw new Error("invalid ledger state");
      return {
        state: {
          version: BOSS_CONTROL_LEDGER_VERSION,
          entries: state.entries.map((entry) => parseEntry(entry, state.version))
        },
        migrated: state.version === EXPIRING_BOSS_CONTROL_LEDGER_VERSION
      };
    } catch (error) {
      const corruptPath = `${this.path}.corrupt-${this.now()}`;
      renameSync2(this.path, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      throw new Error(`Boss control ledger was corrupt and quarantined at ${corruptPath}`, { cause: error });
    }
  }
  persist() {
    writeDurableJson(this.path, this.state);
  }
};

// broker/broker.ts
var INTERCOM_DIR = getIntercomDirPath();
var LISTEN_TARGET = getBrokerListenTarget();
var REMOTE_LISTEN_TARGET = getRemoteGatewaySocketPath();
var PID_PATH = join2(INTERCOM_DIR, "broker.pid");
var OWNER_PATH = join2(INTERCOM_DIR, "broker.owner");
var PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
var ASK_STATE_PATH = getBrokerAskStateFilePath(INTERCOM_DIR);
var ACCESS_STATE_PATH = getBrokerAccessStateFilePath(INTERCOM_DIR);
var ADMIN_CREDENTIAL_PATH = getBrokerAdminCredentialFilePath(INTERCOM_DIR);
var AUDIT_PATH = getBrokerAuditFilePath(INTERCOM_DIR);
var BOSS_CONTROL_LEDGER_PATH = join2(INTERCOM_DIR, "boss-control-results.json");
var BROKER_STATE_ID = randomUUID3();
var MAX_SESSIONS = 128;
var MAX_UNREGISTERED_CONNECTIONS = 32;
var REGISTRATION_TIMEOUT_MS = 1e3;
var RATE_LIMIT_CAPACITY = 240;
var RATE_LIMIT_REFILL_PER_SECOND = 120;
var REMOTE_RATE_LIMIT_CAPACITY = 60;
var REMOTE_RATE_LIMIT_REFILL_PER_SECOND = 30;
var REMOTE_EXPIRY_SWEEP_MS = Math.max(50, Number.parseInt(process.env.PI_INTERCOM_REMOTE_EXPIRY_SWEEP_MS ?? "1000", 10) || 1e3);
var PRESENCE_HEARTBEAT_MS = 1e3;
var DELIVERY_ACK_TIMEOUT_MS = 8e3;
var RECENT_DELIVERY_TTL_MS = 10 * 60 * 1e3;
var MAX_PENDING_DELIVERIES = 1024;
var MAX_PENDING_DELIVERIES_PER_SESSION = 64;
var MAX_PENDING_ASKS_PER_SESSION = 64;
var RATE_LIMIT_BYTES_PER_TOKEN = 8 * 1024;
var MAX_MESSAGE_TEXT_BYTES = 256 * 1024;
var MAX_ATTACHMENT_CONTENT_BYTES = 512 * 1024;
var MAX_ATTACHMENTS = 16;
var MAX_MESSAGE_ID_LENGTH = 256;
var MAX_TARGET_LENGTH = 512;
var MAX_SESSION_NAME_LENGTH = 256;
var MAX_SESSION_CWD_LENGTH = 4096;
var MAX_SESSION_MODEL_LENGTH = 512;
var MAX_SESSION_STATUS_LENGTH = 512;
var MAX_RUNTIME_INSTANCE_ID_LENGTH = 256;
function isAttachment(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const attachment = value;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") {
    return false;
  }
  if (typeof attachment.name !== "string" || attachment.name.length > 256 || typeof attachment.content !== "string" || Buffer.byteLength(attachment.content, "utf-8") > MAX_ATTACHMENT_CONTENT_BYTES) {
    return false;
  }
  return attachment.language === void 0 || typeof attachment.language === "string";
}
function isMessage(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value;
  if (typeof message.id !== "string" || message.id.length === 0 || message.id.length > MAX_MESSAGE_ID_LENGTH || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
    return false;
  }
  if (message.replyTo !== void 0 && (typeof message.replyTo !== "string" || message.replyTo.length === 0 || message.replyTo.length > MAX_MESSAGE_ID_LENGTH)) {
    return false;
  }
  if (message.expectsReply !== void 0 && typeof message.expectsReply !== "boolean") {
    return false;
  }
  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }
  const content = message.content;
  if (typeof content.text !== "string" || Buffer.byteLength(content.text, "utf-8") > MAX_MESSAGE_TEXT_BYTES) {
    return false;
  }
  return content.attachments === void 0 || Array.isArray(content.attachments) && content.attachments.length <= MAX_ATTACHMENTS && content.attachments.every(isAttachment);
}
function isSessionId(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isSessionRegistration(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const session = value;
  if (typeof session.cwd !== "string" || session.cwd.length === 0 || session.cwd.length > MAX_SESSION_CWD_LENGTH || typeof session.model !== "string" || session.model.length === 0 || session.model.length > MAX_SESSION_MODEL_LENGTH || typeof session.pid !== "number" || !Number.isFinite(session.pid) || typeof session.startedAt !== "number" || !Number.isFinite(session.startedAt) || typeof session.lastActivity !== "number" || !Number.isFinite(session.lastActivity)) {
    return false;
  }
  if (session.boss !== void 0) {
    try {
      parseBossParticipantRegistrationMetadata(session.boss);
    } catch {
      return false;
    }
  }
  if (session.name !== void 0 && (typeof session.name !== "string" || session.name.length > MAX_SESSION_NAME_LENGTH)) {
    return false;
  }
  if (session.runtimeInstanceId !== void 0 && (typeof session.runtimeInstanceId !== "string" || session.runtimeInstanceId.length === 0 || session.runtimeInstanceId.length > MAX_RUNTIME_INSTANCE_ID_LENGTH)) {
    return false;
  }
  return session.status === void 0 || typeof session.status === "string" && session.status.length <= MAX_SESSION_STATUS_LENGTH;
}
function isSameLocalRuntime(previous, registration) {
  if (previous.runtimeInstanceId !== void 0 || registration.runtimeInstanceId !== void 0) {
    return previous.runtimeInstanceId !== void 0 && previous.runtimeInstanceId === registration.runtimeInstanceId;
  }
  return previous.info.pid === registration.pid && previous.info.startedAt === registration.startedAt;
}
var IntercomBroker = class {
  sessions = /* @__PURE__ */ new Map();
  askEdges = /* @__PURE__ */ new Map();
  pendingDeliveries = /* @__PURE__ */ new Map();
  pendingDeliveryKeys = /* @__PURE__ */ new Map();
  recentDeliveries = /* @__PURE__ */ new Map();
  pendingBossControls = /* @__PURE__ */ new Map();
  pendingBossControlKeys = /* @__PURE__ */ new Map();
  connections = /* @__PURE__ */ new Set();
  unregisteredConnections = /* @__PURE__ */ new Set();
  server;
  remoteServer = null;
  shutdownTimer = null;
  expiryTimer = null;
  askTimeoutMs = getAskTimeoutMs();
  accessRegistry;
  audit;
  bossControlLedger;
  constructor() {
    ensureIntercomRuntimeDir(INTERCOM_DIR);
    acquireBrokerOwnership(OWNER_PATH);
    this.accessRegistry = new RemoteAccessRegistry(ACCESS_STATE_PATH);
    this.audit = new BrokerAuditLog(AUDIT_PATH);
    this.bossControlLedger = new BossControlResultLedger(BOSS_CONTROL_LEDGER_PATH);
    this.accessRegistry.ensureAdminCredential(ADMIN_CREDENTIAL_PATH);
    this.loadAskEdges();
    if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      for (const socketPath of [LISTEN_TARGET, REMOTE_LISTEN_TARGET]) {
        try {
          unlinkSync2(socketPath);
        } catch {
        }
      }
    }
    this.server = net.createServer((socket) => this.handleConnection(socket, "local"));
    if (process.platform !== "win32" && typeof LISTEN_TARGET === "string") {
      this.remoteServer = net.createServer((socket) => this.handleConnection(socket, "remote"));
    }
  }
  start() {
    let localListening = false;
    let remoteListening = this.remoteServer === null;
    const announceWhenReady = () => {
      if (!localListening || !remoteListening) return;
      writeFileSync3(PID_PATH, String(process.pid), { mode: INTERCOM_RUNTIME_FILE_MODE });
      restrictIntercomRuntimeFile(PID_PATH);
      console.log(`Intercom broker started (pid: ${process.pid}, remote-access-v1)`);
    };
    const onLocalListening = () => {
      if (typeof LISTEN_TARGET === "string") {
        restrictIntercomRuntimeFile(LISTEN_TARGET);
      } else {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Intercom TCP broker started without a TCP address");
        }
        const endpoint = {
          transport: "tcp",
          host: LISTEN_TARGET.host,
          port: address.port,
          stateId: BROKER_STATE_ID
        };
        writeFileSync3(PORT_PATH, `${JSON.stringify(endpoint)}
`, { mode: INTERCOM_RUNTIME_FILE_MODE });
        restrictIntercomRuntimeFile(PORT_PATH);
      }
      localListening = true;
      announceWhenReady();
    };
    if (typeof LISTEN_TARGET === "string") {
      this.server.listen(LISTEN_TARGET, onLocalListening);
    } else {
      this.server.listen({ host: LISTEN_TARGET.host, port: LISTEN_TARGET.port }, onLocalListening);
    }
    if (this.remoteServer) {
      this.remoteServer.listen(REMOTE_LISTEN_TARGET, () => {
        restrictIntercomRuntimeFile(REMOTE_LISTEN_TARGET);
        remoteListening = true;
        announceWhenReady();
      });
    }
    this.expiryTimer = setInterval(() => this.reconcileExpiredPrincipals(), REMOTE_EXPIRY_SWEEP_MS);
    this.expiryTimer.unref?.();
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }
  handleConnection(socket, origin) {
    this.connections.add(socket);
    let sessionId = null;
    let registrationTimeout = null;
    const armRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
      }
      this.unregisteredConnections.delete(socket);
      this.unregisteredConnections.add(socket);
      this.evictOldestUnregisteredConnections(socket);
      registrationTimeout = setTimeout(() => {
        if (!sessionId) {
          socket.destroy();
        }
      }, REGISTRATION_TIMEOUT_MS);
      registrationTimeout.unref?.();
    };
    const clearRegistrationTimeout = () => {
      if (registrationTimeout) {
        clearTimeout(registrationTimeout);
        registrationTimeout = null;
      }
      this.unregisteredConnections.delete(socket);
    };
    armRegistrationTimeout();
    const connection = {
      socket,
      origin,
      tokens: origin === "remote" ? REMOTE_RATE_LIMIT_CAPACITY : RATE_LIMIT_CAPACITY,
      refillPerSecond: origin === "remote" ? REMOTE_RATE_LIMIT_REFILL_PER_SECOND : RATE_LIMIT_REFILL_PER_SECOND,
      lastRefillAt: Date.now()
    };
    const reader = createMessageReader((msg) => {
      const byteCost = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(msg), "utf-8") / RATE_LIMIT_BYTES_PER_TOKEN));
      if (!this.consumeToken(connection, byteCost)) {
        this.sendError(socket, "RATE_LIMITED", "Intercom broker rate limit exceeded");
        socket.destroy(new Error("Intercom broker rate limit exceeded"));
        return;
      }
      try {
        this.handleMessage(socket, origin, msg, sessionId, (id) => {
          sessionId = id;
          if (id) {
            clearRegistrationTimeout();
          } else {
            armRegistrationTimeout();
          }
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === "Invalid intercom TCP endpoint credentials") {
          socket.destroy();
          return;
        }
        this.sendError(socket, "INVALID_REQUEST", reason);
        socket.end();
      }
    }, (error) => {
      socket.destroy(error);
    });
    socket.on("data", reader);
    socket.on("close", () => {
      clearRegistrationTimeout();
      this.connections.delete(socket);
      if (sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing?.socket === socket) {
          if (existing.info.origin === "remote") {
            this.audit.tryRecord({
              event: "remote_disconnect",
              outcome: "observed",
              actorId: sessionId,
              remoteHostId: existing.info.remoteHostId,
              generation: existing.info.generation,
              reason: "SOCKET_CLOSED"
            });
          }
          this.broadcastLifecycle({ type: "session_left", sessionId }, existing, sessionId);
          this.sessions.delete(sessionId);
          this.clearPendingDeliveriesForSession(sessionId, socket);
          this.deferAskEdgesForSession(sessionId);
          this.scheduleShutdownCheck();
        }
      }
    });
    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }
  evictOldestUnregisteredConnections(currentSocket) {
    while (this.unregisteredConnections.size > MAX_UNREGISTERED_CONNECTIONS) {
      const [oldest] = this.unregisteredConnections;
      if (!oldest) {
        return;
      }
      if (oldest === currentSocket && this.unregisteredConnections.size === 1) {
        return;
      }
      this.unregisteredConnections.delete(oldest);
      oldest.destroy();
    }
  }
  consumeToken(connection, cost = 1, now = Date.now()) {
    const elapsedMs = now - connection.lastRefillAt;
    if (elapsedMs > 0) {
      connection.tokens = Math.min(
        connection.origin === "remote" ? REMOTE_RATE_LIMIT_CAPACITY : RATE_LIMIT_CAPACITY,
        connection.tokens + elapsedMs * connection.refillPerSecond / 1e3
      );
      connection.lastRefillAt = now;
    }
    if (connection.tokens < cost) {
      return false;
    }
    connection.tokens -= cost;
    return true;
  }
  sendError(socket, code, error) {
    writeMessage(socket, { type: "error", code, error });
  }
  sendDeliveryFailure(socket, messageId, accepted, code, reason) {
    writeMessage(socket, { type: "delivery_failed", messageId, accepted, code, reason });
  }
  sendBossControlFailure(socket, requestId, messageId, idempotencyKey, code, reason, deliveryId, ledgerBinding, acknowledgeAcceptedRecovery = false) {
    const result = {
      type: "boss_control_result",
      requestId,
      messageId,
      idempotencyKey,
      status: "rejected",
      delivered: false,
      code,
      reason,
      ...deliveryId === void 0 ? {} : { deliveryId }
    };
    if (ledgerBinding) {
      this.bossControlLedger.recordTerminal(ledgerBinding.scope, ledgerBinding.fingerprint, result);
    }
    if (acknowledgeAcceptedRecovery) {
      for (const frame of bossControlAcceptedRecoveryFrames(result)) writeMessage(socket, frame);
    } else {
      writeMessage(socket, result);
    }
  }
  scheduleShutdownCheck() {
    if (this.shutdownTimer) return;
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5e3);
  }
  handleMessage(socket, origin, msg, currentId, setId) {
    if (typeof msg !== "object" || msg === null || nodeUtilTypes2.isProxy(msg)) {
      throw new Error("Invalid client message");
    }
    const typeDescriptor = Object.getOwnPropertyDescriptor(msg, "type");
    if (typeDescriptor === void 0 || !typeDescriptor.enumerable || !Object.hasOwn(typeDescriptor, "value") || typeof typeDescriptor.value !== "string") throw new Error("Invalid client message");
    const clientMessage = msg;
    const requiresEndpointAuth = typeof LISTEN_TARGET !== "string";
    const hasEndpointAuth = clientMessage.stateId === BROKER_STATE_ID;
    if (clientMessage.type === "health") {
      if (typeof clientMessage.requestId !== "string") {
        throw new Error("Invalid health message");
      }
      if (requiresEndpointAuth && !hasEndpointAuth) {
        throw new Error("Invalid intercom TCP endpoint credentials");
      }
      writeMessage(socket, {
        type: "health_ok",
        requestId: clientMessage.requestId,
        protocol: INTERCOM_PROTOCOL_NAME2,
        version: INTERCOM_PROTOCOL_VERSION2,
        endpoint: origin,
        remoteAccess: this.remoteAccessContract(),
        ...bossCapabilityAdvertisement() === void 0 ? {} : { capabilities: bossCapabilityAdvertisement() }
      });
      return;
    }
    if (clientMessage.type === "access_control") {
      if (currentId !== null) {
        this.sendError(socket, "ACCESS_DENIED", "Remote access control requires a short-lived control connection");
        socket.end();
        return;
      }
      if (origin === "local") this.handleAccessControl(socket, clientMessage);
      else this.handleRemoteAccessControl(socket, clientMessage);
      return;
    }
    if (requiresEndpointAuth && clientMessage.type === "register" && !hasEndpointAuth) {
      throw new Error("Invalid intercom TCP endpoint credentials");
    }
    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }
    if (currentId) {
      const bound = this.sessions.get(currentId);
      if (bound?.socket !== socket) {
        socket.destroy();
        return;
      }
      if (!this.isCurrentPrincipal(currentId)) {
        this.sendError(socket, "ACCESS_DENIED", "Remote session authorization is no longer valid");
        socket.destroy();
        return;
      }
    }
    switch (clientMessage.type) {
      case "register": {
        try {
          parseExactRegistrationFrame(clientMessage);
        } catch (error) {
          this.sendError(socket, "BOSS_CONTRACT_MISMATCH", error instanceof Error ? error.message : "Registration contract is invalid");
          socket.end();
          break;
        }
        if (clientMessage.protocol !== INTERCOM_PROTOCOL_NAME2 || clientMessage.version !== INTERCOM_PROTOCOL_VERSION2) {
          this.sendError(
            socket,
            "PROTOCOL_MISMATCH",
            `Unsupported intercom protocol; expected ${INTERCOM_PROTOCOL_NAME2} v${INTERCOM_PROTOCOL_VERSION2}`
          );
          socket.end();
          break;
        }
        let scopeId;
        try {
          parseIntercomScopeId(clientMessage.scopeId, "invalid-config");
          scopeId = clientMessage.scopeId;
        } catch {
          this.sendError(socket, "INVALID_REQUEST", "Invalid session configuration");
          socket.end();
          break;
        }
        if (!isSessionRegistration(clientMessage.session)) {
          this.sendError(socket, "BOSS_CONTRACT_MISMATCH", "Registration session contract is invalid");
          socket.end();
          break;
        }
        if (currentId) {
          throw new Error("Received duplicate register message");
        }
        if (clientMessage.session.boss !== void 0) {
          if (origin !== "local") {
            this.sendError(socket, "ACCESS_DENIED", "Boss participants require the protected local broker endpoint");
          } else if (bossCapabilityAdvertisement() === void 0) {
            this.sendError(socket, "BOSS_FEATURE_UNAVAILABLE", "boss-run-v1 is not advertised by this broker");
          } else {
            this.sendError(socket, "BOSS_FEATURE_UNAVAILABLE", "Boss participant credential binding is not installed");
          }
          socket.end();
          break;
        }
        let id;
        let previousLocal;
        let remotePrincipal;
        let issuedSessionCredential;
        let enrollmentConsumed = false;
        if (origin === "remote") {
          if (this.sessions.size >= MAX_SESSIONS) {
            this.sendError(socket, "TOO_MANY_SESSIONS", "Too many registered intercom sessions");
            socket.destroy();
            break;
          }
          const access = clientMessage.access;
          if (typeof access !== "object" || access === null || Array.isArray(access)) {
            this.audit.tryRecord({ event: "remote_registration_denied", outcome: "denied", reason: "MISSING_CREDENTIAL" });
            this.sendError(socket, "ACCESS_DENIED", "Remote registration requires an access credential");
            socket.end();
            break;
          }
          const fields = access;
          try {
            if (typeof fields.enrollmentToken === "string") {
              const consumed = this.accessRegistry.consumeEnrollment(fields.enrollmentToken);
              remotePrincipal = consumed.principal;
              issuedSessionCredential = consumed.sessionCredential;
              enrollmentConsumed = true;
            } else if (typeof fields.sessionCredential === "string" && typeof fields.sessionId === "string" && typeof fields.generation === "number" && Number.isSafeInteger(fields.generation)) {
              remotePrincipal = this.accessRegistry.authenticateSession(fields.sessionId, fields.generation, fields.sessionCredential);
            } else {
              throw new Error("Invalid remote access credential shape");
            }
          } catch {
            this.audit.tryRecord({ event: "remote_registration_denied", outcome: "denied", reason: "INVALID_CREDENTIAL" });
            this.sendError(socket, "ACCESS_DENIED", "Remote registration credential was rejected");
            socket.end();
            break;
          }
          id = remotePrincipal.id;
          if (this.sessions.has(id)) {
            this.audit.tryRecord({
              event: "credential_reuse_denied",
              outcome: "denied",
              actorId: id,
              remoteHostId: remotePrincipal.remoteHostId,
              generation: remotePrincipal.generation,
              reason: "ALREADY_ACTIVE"
            });
            this.sendError(socket, "ACCESS_DENIED", "Remote session credential is already active");
            socket.end();
            break;
          }
        } else {
          id = randomUUID3();
          if (clientMessage.sessionId !== void 0) {
            if (!isSessionId(clientMessage.sessionId)) {
              throw new Error("Invalid register sessionId");
            }
            id = clientMessage.sessionId;
          }
          previousLocal = this.sessions.get(id);
          if (!previousLocal && this.sessions.size >= MAX_SESSIONS) {
            this.sendError(socket, "TOO_MANY_SESSIONS", "Too many registered intercom sessions");
            socket.destroy();
            break;
          }
          if (previousLocal && !isSameLocalRuntime(previousLocal, clientMessage.session)) {
            this.sendError(
              socket,
              "SESSION_ID_IN_USE",
              `Session ID "${id}" is already active in another local runtime; close the existing session or use a different session ID`
            );
            socket.end();
            break;
          }
        }
        setId(id);
        const session = clientMessage.session;
        const info = remotePrincipal ? {
          id,
          name: remotePrincipal.name,
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...session.status !== void 0 ? { status: session.status } : {},
          trustedLocal: false,
          origin: "remote",
          remoteHostId: remotePrincipal.remoteHostId,
          parentSessionId: remotePrincipal.parentSessionId,
          rootSessionId: remotePrincipal.rootSessionId,
          generation: remotePrincipal.generation,
          canDelegate: remotePrincipal.canDelegate,
          depth: remotePrincipal.depth,
          maxDepth: remotePrincipal.maxDepth,
          maxChildren: remotePrincipal.maxChildren
        } : {
          id,
          ...session.name !== void 0 ? { name: session.name } : {},
          cwd: session.cwd,
          model: session.model,
          pid: session.pid,
          startedAt: session.startedAt,
          lastActivity: session.lastActivity,
          ...session.status !== void 0 ? { status: session.status } : {},
          trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32",
          origin: "local"
        };
        if (remotePrincipal) {
          this.audit.record({
            event: enrollmentConsumed ? "enrollment_consumed" : "remote_reconnect",
            outcome: "allowed",
            actorId: id,
            targetId: remotePrincipal.parentSessionId,
            remoteHostId: remotePrincipal.remoteHostId,
            generation: remotePrincipal.generation
          });
          this.audit.record({
            event: "remote_connect",
            outcome: "allowed",
            actorId: id,
            targetId: remotePrincipal.parentSessionId,
            remoteHostId: remotePrincipal.remoteHostId,
            generation: remotePrincipal.generation
          });
        }
        const connected = {
          socket,
          info,
          ...scopeId ? { scopeId } : {},
          ...!remotePrincipal && clientMessage.session.runtimeInstanceId ? { runtimeInstanceId: clientMessage.session.runtimeInstanceId } : {},
          lastPresenceBroadcastAt: Date.now()
        };
        if (previousLocal) {
          this.broadcastLifecycle({ type: "session_left", sessionId: id }, previousLocal, id);
          this.clearPendingDeliveriesForSession(id, previousLocal.socket);
          this.deferAskEdgesForSession(id);
        }
        this.sessions.set(id, connected);
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }
        writeMessage(socket, {
          type: "registered",
          sessionId: id,
          protocol: INTERCOM_PROTOCOL_NAME2,
          version: INTERCOM_PROTOCOL_VERSION2,
          ...remotePrincipal ? {
            remoteAccess: this.remoteAccessContract(),
            access: {
              origin: "remote",
              remoteHostId: remotePrincipal.remoteHostId,
              parentSessionId: remotePrincipal.parentSessionId,
              rootSessionId: remotePrincipal.rootSessionId,
              generation: remotePrincipal.generation,
              canDelegate: remotePrincipal.canDelegate,
              depth: remotePrincipal.depth,
              maxDepth: remotePrincipal.maxDepth,
              maxChildren: remotePrincipal.maxChildren,
              ...issuedSessionCredential ? { sessionCredential: issuedSessionCredential } : {}
            }
          } : {}
        });
        this.broadcastLifecycle({ type: "session_joined", session: info }, connected, id);
        previousLocal?.socket.end();
        break;
      }
      case "unregister": {
        if (!currentId) {
          throw new Error("Received unregister before register");
        }
        if (clientMessage.preserveAsks !== void 0 && typeof clientMessage.preserveAsks !== "boolean") {
          throw new Error("Invalid unregister preserveAsks value");
        }
        const existing = this.sessions.get(currentId);
        if (existing?.socket === socket) {
          if (existing.info.origin === "remote") {
            this.audit.tryRecord({
              event: "remote_disconnect",
              outcome: "observed",
              actorId: currentId,
              remoteHostId: existing.info.remoteHostId,
              generation: existing.info.generation,
              reason: "UNREGISTERED"
            });
          }
          this.broadcastLifecycle({ type: "session_left", sessionId: currentId }, existing, currentId);
          this.sessions.delete(currentId);
          this.clearPendingDeliveriesForSession(currentId, socket);
          if (clientMessage.preserveAsks) {
            this.deferAskEdgesForSession(currentId);
          } else {
            this.clearAskEdgesForSession(currentId, "session_disconnected");
          }
          this.scheduleShutdownCheck();
        }
        setId(null);
        break;
      }
      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }
        const actor = this.sessions.get(currentId);
        const sameScopeSessions = actor ? Array.from(this.sessions.values()).filter((candidate) => sameIntercomScope(actor.scopeId, candidate.scopeId)).map((candidate) => candidate.info) : [];
        const allSessions = sameScopeSessions;
        const sessions = visibleSessions(allSessions, currentId);
        if (actor?.info.origin === "remote" && sessions.length < allSessions.length) {
          this.audit.tryRecord({
            event: "remote_visibility_filtered",
            outcome: "observed",
            actorId: currentId,
            remoteHostId: actor.info.remoteHostId,
            generation: actor.info.generation,
            visibleCount: sessions.length,
            hiddenCount: allSessions.length - sessions.length
          });
        }
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }
      case "send": {
        if (!currentId) {
          throw new Error("Received send before register");
        }
        const message = clientMessage.message;
        const messageId = typeof message === "object" && message !== null && "id" in message && typeof message.id === "string" && message.id.length > 0 && message.id.length <= MAX_MESSAGE_ID_LENGTH ? message.id : "unknown";
        if (typeof clientMessage.to !== "string" || clientMessage.to.length === 0 || clientMessage.to.length > MAX_TARGET_LENGTH || !isMessage(message)) {
          this.sendDeliveryFailure(socket, messageId, false, "INVALID_MESSAGE", "Invalid message format");
          break;
        }
        const action = message.replyTo ? "reply" : message.expectsReply ? "ask" : "send";
        this.pruneRecentDeliveries();
        const deliveryKey = this.deliveryKey(currentId, message.id);
        const fingerprint = JSON.stringify({
          to: clientMessage.to,
          replyTo: message.replyTo,
          expectsReply: message.expectsReply,
          content: message.content
        });
        const recent = this.recentDeliveries.get(deliveryKey);
        if (recent) {
          if (recent.fingerprint !== fingerprint) {
            this.sendDeliveryFailure(socket, message.id, false, "DUPLICATE_MESSAGE_ID", "Message ID was already used with a different payload");
            break;
          }
          const actor = this.sessions.get(currentId);
          const target = this.sessions.get(recent.to);
          const authorizationStillValid = Boolean(
            actor && target && (actor.info.generation ?? 1) === recent.fromGeneration && (target.info.generation ?? 1) === recent.toGeneration && this.isAuthorized(currentId, recent.action, recent.to)
          );
          if (recent.retryable || !authorizationStillValid) {
            this.recentDeliveries.delete(deliveryKey);
          } else {
            if (recent.response.type === "delivered") {
              writeMessage(socket, {
                type: "delivery_accepted",
                messageId: message.id,
                deliveryId: recent.response.deliveryId
              });
            }
            writeMessage(socket, recent.response);
            break;
          }
        }
        const existingDeliveryId = this.pendingDeliveryKeys.get(deliveryKey);
        if (existingDeliveryId) {
          const existing = this.pendingDeliveries.get(existingDeliveryId);
          if (!existing || existing.fingerprint !== fingerprint) {
            this.sendDeliveryFailure(socket, message.id, false, "DUPLICATE_MESSAGE_ID", "Message ID is already pending with a different payload");
            break;
          }
          const actor = this.sessions.get(existing.from);
          const target = this.sessions.get(existing.to);
          if (actor && target && (actor.info.generation ?? 1) === existing.fromGeneration && (target.info.generation ?? 1) === existing.toGeneration && this.isAuthorized(existing.from, existing.action, existing.to)) {
            writeMessage(socket, { type: "delivery_accepted", messageId: message.id, deliveryId: existing.id });
            break;
          }
          this.failPendingDelivery(existing.id, "SESSION_NOT_FOUND", "Delivery authorization changed while pending");
        }
        if (this.pendingDeliveries.size >= MAX_PENDING_DELIVERIES || this.countPendingDeliveriesFrom(currentId) >= MAX_PENDING_DELIVERIES_PER_SESSION) {
          this.sendDeliveryFailure(socket, message.id, false, "TOO_MANY_PENDING_DELIVERIES", "Too many messages are waiting for receiver acknowledgement");
          break;
        }
        const candidates = this.findSessions(currentId, clientMessage.to);
        const targets = candidates.filter((target) => this.isAuthorized(currentId, action, target.info.id));
        if (candidates.length > 0 && targets.length === 0) {
          const actor = this.sessions.get(currentId);
          this.audit.tryRecord({
            event: "remote_delivery_denied",
            outcome: "denied",
            actorId: currentId,
            targetId: candidates.length === 1 ? candidates[0].info.id : void 0,
            remoteHostId: actor?.info.remoteHostId ?? candidates.find((candidate) => candidate.info.remoteHostId)?.info.remoteHostId,
            generation: actor?.info.generation,
            reason: "POLICY_DENIED"
          });
        }
        if (targets.length === 1) {
          const fromSession = this.sessions.get(currentId);
          if (!fromSession || fromSession.socket !== socket) {
            this.sendDeliveryFailure(socket, message.id, false, "SENDER_NOT_FOUND", "Sender session not found");
            break;
          }
          const target = targets[0];
          const replyEdge = message.replyTo ? this.askEdges.get(this.askKey(target.info.id, message.replyTo)) : void 0;
          if (message.replyTo && !replyEdge) {
            this.sendDeliveryFailure(socket, message.id, false, "INVALID_REPLY_TARGET", "Reply target does not match a pending ask");
            break;
          }
          if (replyEdge && (replyEdge.to !== currentId || replyEdge.from !== target.info.id)) {
            this.sendDeliveryFailure(socket, message.id, false, "INVALID_REPLY_TARGET", "Reply target does not match the pending ask");
            break;
          }
          if (message.expectsReply) {
            const existingAsk = Array.from(this.askEdges.values()).find(
              (edge) => edge.from === currentId && edge.to === target.info.id
            );
            if (existingAsk) {
              this.sendDeliveryFailure(socket, message.id, false, "ASK_ALREADY_PENDING", "Another ask to this session is still unresolved. Wait for its reply or use intercom_send for a non-blocking follow-up.");
              break;
            }
            const reverseEdge = Array.from(this.askEdges.values()).find(
              (edge) => edge.state === "blocking" && !(message.replyTo === edge.messageId && target.info.id === edge.from) && edge.from === target.info.id && edge.to === currentId
            );
            if (reverseEdge) {
              this.sendDeliveryFailure(socket, message.id, false, "MUTUAL_ASK", "Mutual ask refused: target session is already waiting for a reply from this session.");
              break;
            }
            if (this.countAskEdgesFrom(currentId) >= MAX_PENDING_ASKS_PER_SESSION) {
              this.sendDeliveryFailure(socket, message.id, false, "TOO_MANY_PENDING_ASKS", "Too many asks are already waiting for replies");
              break;
            }
            this.addAskEdge(message.id, currentId, target.info.id);
          }
          const deliveryId = randomUUID3();
          const timeout = setTimeout(() => {
            this.failPendingDelivery(deliveryId, "DELIVERY_TIMEOUT", "Recipient did not acknowledge the message in time");
          }, DELIVERY_ACK_TIMEOUT_MS);
          timeout.unref?.();
          const pending = {
            id: deliveryId,
            key: deliveryKey,
            fingerprint,
            message,
            from: currentId,
            to: target.info.id,
            senderSocket: socket,
            recipientSocket: target.socket,
            action,
            fromGeneration: fromSession.info.generation ?? 1,
            toGeneration: target.info.generation ?? 1,
            timeout
          };
          this.pendingDeliveries.set(deliveryId, pending);
          this.pendingDeliveryKeys.set(deliveryKey, deliveryId);
          writeMessage(socket, { type: "delivery_accepted", messageId: message.id, deliveryId });
          writeMessage(target.socket, {
            type: "message",
            deliveryId,
            from: fromSession.info,
            message
          });
          break;
        }
        if (targets.length > 1) {
          this.sendDeliveryFailure(socket, message.id, false, "AMBIGUOUS_TARGET", `Multiple sessions named "${clientMessage.to}" are connected. Use the session ID instead.`);
          break;
        }
        this.sendDeliveryFailure(socket, message.id, false, "SESSION_NOT_FOUND", "Session not found");
        break;
      }
      case "boss_control": {
        if (!currentId) throw new Error("Received boss_control before register");
        const requestId = clientMessage.requestId;
        const requestedTarget = clientMessage.to;
        if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_MESSAGE_ID_LENGTH || typeof requestedTarget !== "string" || requestedTarget.length === 0 || requestedTarget.length > MAX_TARGET_LENGTH) throw new Error("Invalid boss_control routing metadata");
        const sender = this.sessions.get(currentId);
        let envelope;
        let controlKind;
        try {
          if (!sender || sender.socket !== socket) throw new Error("Boss sender session not found");
          envelope = assertBossControlSender(sender.info, clientMessage.envelope);
          controlKind = bossControlKind(envelope).controlKind;
          if (requestId !== envelope.messageId) {
            throw new Error("requestId must equal the canonical Boss envelope messageId");
          }
        } catch (error) {
          this.sendBossControlFailure(
            socket,
            requestId,
            requestId,
            requestId,
            "INVALID_CONTROL",
            error instanceof Error ? error.message : "Invalid Boss control envelope"
          );
          break;
        }
        const key = this.bossControlKey(currentId, envelope);
        const fingerprint = this.bossControlFingerprint(requestedTarget, envelope);
        const prior = this.bossControlLedger.lookup(key, fingerprint);
        if (prior.status === "replay") {
          for (const frame of bossControlReplayFrames(prior.result, envelope.messageId)) writeMessage(socket, frame);
          break;
        }
        if (prior.status === "conflict") {
          this.sendBossControlFailure(
            socket,
            requestId,
            envelope.messageId,
            envelope.idempotencyKey,
            "IDEMPOTENCY_CONFLICT",
            "Boss idempotency key is durably bound to a different canonical request"
          );
          break;
        }
        const exactTarget = exactBossSessionTarget(this.sessions, requestedTarget);
        const correlated = hasAuthoritativeBossControlCorrelation();
        const target = exactTarget && authorizeSessionAction(
          Array.from(this.sessions.values(), (session) => session.info),
          currentId,
          "control",
          exactTarget.info.id,
          { controlKind, correlated }
        ).allowed ? exactTarget : void 0;
        if (!target) {
          const acceptedDeliveryId = prior.status === "accepted" ? prior.deliveryId : void 0;
          this.sendBossControlFailure(
            socket,
            requestId,
            envelope.messageId,
            envelope.idempotencyKey,
            exactTarget ? "POLICY_DENIED" : "SESSION_NOT_FOUND",
            exactTarget ? "Boss control routing requires authoritative correlation evidence" : "Boss control target session ID was not found",
            acceptedDeliveryId,
            { scope: key, fingerprint },
            acceptedDeliveryId !== void 0
          );
          break;
        }
        const existingDeliveryId = this.pendingBossControlKeys.get(key);
        if (existingDeliveryId) {
          const existing = this.pendingBossControls.get(existingDeliveryId);
          if (!existing || existing.fingerprint !== fingerprint) {
            this.sendBossControlFailure(socket, requestId, envelope.messageId, envelope.idempotencyKey, "IDEMPOTENCY_CONFLICT", "Boss idempotency key is already bound to a different canonical request");
            break;
          }
          if (existing.messageId !== envelope.messageId) {
            existing.requestId = requestId;
            existing.messageId = envelope.messageId;
            existing.envelope = envelope;
            existing.senderSocket = socket;
            writeMessage(existing.recipientSocket, { type: "boss_control", deliveryId: existing.deliveryId, from: sender.info, envelope });
          }
          writeMessage(socket, {
            type: "boss_control_ack",
            requestId,
            messageId: envelope.messageId,
            idempotencyKey: envelope.idempotencyKey,
            status: "accepted",
            deliveryId: existing.deliveryId
          });
          break;
        }
        const deliveryId = prior.status === "accepted" ? prior.deliveryId : randomUUID3();
        if (prior.status === "miss") {
          this.bossControlLedger.recordAccepted(key, fingerprint, deliveryId);
        }
        const timeout = setTimeout(() => {
          this.failPendingBossControl(deliveryId, "DELIVERY_TIMEOUT", "Recipient did not acknowledge the Boss control envelope in time");
        }, DELIVERY_ACK_TIMEOUT_MS);
        timeout.unref?.();
        this.pendingBossControls.set(deliveryId, {
          deliveryId,
          key,
          fingerprint,
          requestId,
          messageId: envelope.messageId,
          envelope,
          from: currentId,
          to: target.info.id,
          senderSocket: socket,
          recipientSocket: target.socket,
          timeout
        });
        this.pendingBossControlKeys.set(key, deliveryId);
        writeMessage(socket, {
          type: "boss_control_ack",
          requestId,
          messageId: envelope.messageId,
          idempotencyKey: envelope.idempotencyKey,
          status: "accepted",
          deliveryId
        });
        writeMessage(target.socket, { type: "boss_control", deliveryId, from: sender.info, envelope });
        break;
      }
      case "boss_control_received": {
        if (!currentId) throw new Error("Received boss_control_received before register");
        if (typeof clientMessage.deliveryId !== "string" || typeof clientMessage.messageId !== "string" || typeof clientMessage.idempotencyKey !== "string") {
          throw new Error("Invalid boss_control_received message");
        }
        this.acknowledgePendingBossControl(clientMessage.deliveryId, clientMessage.messageId, clientMessage.idempotencyKey, currentId, socket);
        break;
      }
      case "message_received": {
        if (!currentId) {
          throw new Error("Received message_received before register");
        }
        if (typeof clientMessage.deliveryId !== "string") {
          throw new Error("Invalid message_received message");
        }
        this.acknowledgePendingDelivery(clientMessage.deliveryId, currentId, socket);
        break;
      }
      case "message_rejected": {
        if (!currentId) {
          throw new Error("Received message_rejected before register");
        }
        if (typeof clientMessage.deliveryId !== "string" || clientMessage.code !== "CONFLICTING_MESSAGE_ID" || typeof clientMessage.reason !== "string" || clientMessage.reason.length > 1024) {
          throw new Error("Invalid message_rejected message");
        }
        const pending = this.pendingDeliveries.get(clientMessage.deliveryId);
        if (pending?.to === currentId && pending.recipientSocket === socket) {
          this.failPendingDelivery(clientMessage.deliveryId, clientMessage.code, clientMessage.reason);
        }
        break;
      }
      case "defer_ask": {
        if (!currentId) {
          throw new Error("Received defer_ask before register");
        }
        if (typeof clientMessage.messageId !== "string" || clientMessage.messageId.length > MAX_MESSAGE_ID_LENGTH || typeof clientMessage.requestId !== "string" || clientMessage.requestId.length > MAX_MESSAGE_ID_LENGTH) {
          throw new Error("Invalid defer_ask message");
        }
        const session = this.sessions.get(currentId);
        const edge = this.askEdges.get(this.askKey(currentId, clientMessage.messageId));
        const applied = Boolean(session?.socket === socket && edge?.from === currentId);
        if (applied && edge?.state === "blocking") {
          edge.state = "deferred";
          this.persistAskEdges();
          this.notifyAskDeferred(edge);
        }
        writeMessage(socket, { type: "ask_control_result", requestId: clientMessage.requestId, action: "defer", messageId: clientMessage.messageId, applied });
        break;
      }
      case "cancel_ask": {
        if (!currentId) {
          throw new Error("Received cancel_ask before register");
        }
        if (typeof clientMessage.messageId !== "string" || clientMessage.messageId.length > MAX_MESSAGE_ID_LENGTH || typeof clientMessage.requestId !== "string" || clientMessage.requestId.length > MAX_MESSAGE_ID_LENGTH) {
          throw new Error("Invalid cancel_ask message");
        }
        const session = this.sessions.get(currentId);
        const edgeKey = this.askKey(currentId, clientMessage.messageId);
        const edge = this.askEdges.get(edgeKey);
        const applied = Boolean(session?.socket === socket && edge?.from === currentId);
        if (applied) {
          this.removeAskEdge(edgeKey, "cancelled", true);
        }
        writeMessage(socket, { type: "ask_control_result", requestId: clientMessage.requestId, action: "cancel", messageId: clientMessage.messageId, applied });
        break;
      }
      case "presence": {
        if (!currentId) {
          throw new Error("Received presence before register");
        }
        const session = this.sessions.get(currentId);
        if (session?.socket === socket) {
          let changed = false;
          if (clientMessage.name !== void 0) {
            if (typeof clientMessage.name !== "string" || clientMessage.name.length > MAX_SESSION_NAME_LENGTH) {
              throw new Error("Invalid presence name");
            }
            if (session.info.origin !== "remote" && session.info.name !== clientMessage.name) {
              session.info.name = clientMessage.name;
              changed = true;
            }
          }
          if (clientMessage.status !== void 0) {
            if (typeof clientMessage.status !== "string" || clientMessage.status.length > MAX_SESSION_STATUS_LENGTH) {
              throw new Error("Invalid presence status");
            }
            if (session.info.status !== clientMessage.status) {
              session.info.status = clientMessage.status;
              changed = true;
            }
          }
          if (clientMessage.model !== void 0) {
            if (typeof clientMessage.model !== "string" || clientMessage.model.length > MAX_SESSION_MODEL_LENGTH) {
              throw new Error("Invalid presence model");
            }
            if (session.info.model !== clientMessage.model) {
              session.info.model = clientMessage.model;
              changed = true;
            }
          }
          const now = Date.now();
          session.info.lastActivity = now;
          if (changed || now - session.lastPresenceBroadcastAt >= PRESENCE_HEARTBEAT_MS) {
            session.lastPresenceBroadcastAt = now;
            this.broadcastLifecycle({ type: "presence_update", session: session.info }, session, currentId);
          }
        }
        break;
      }
      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }
  remoteAccessContract() {
    return {
      feature: "remote-access-v1",
      policySemanticsVersion: POLICY_SEMANTICS_VERSION,
      policySemanticsHash: POLICY_SEMANTICS_HASH
    };
  }
  handleAccessControl(socket, message) {
    if (typeof message.requestId !== "string" || message.requestId.length > MAX_MESSAGE_ID_LENGTH || typeof message.adminToken !== "string" || !this.accessRegistry.authenticateAdmin(message.adminToken)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote access control credential or request was rejected");
      socket.end();
      return;
    }
    if (message.action === "inspect_tree") {
      if (typeof message.principalId !== "string" || !isSessionId(message.principalId)) {
        this.sendError(socket, "INVALID_REQUEST", "Invalid remote principal ID");
        socket.end();
        return;
      }
      const principals = this.accessRegistry.inspectSubtree(message.principalId).map((principal) => this.principalSummary(principal));
      this.audit.record({
        event: "tree_inspected",
        outcome: "allowed",
        actorId: "local-admin",
        targetId: message.principalId,
        visibleCount: principals.length
      });
      writeMessage(socket, { type: "access_control_result", requestId: message.requestId, action: "inspect_tree", principals });
      socket.end();
      return;
    }
    if (message.action === "adopt_subtree") {
      if (typeof message.principalId !== "string" || !isSessionId(message.principalId) || typeof message.newParentSessionId !== "string" || !isSessionId(message.newParentSessionId)) {
        this.sendError(socket, "INVALID_REQUEST", "Invalid adoption request");
        socket.end();
        return;
      }
      const localParent = this.sessions.get(message.newParentSessionId);
      const remoteParent = this.accessRegistry.snapshot().principals[message.newParentSessionId];
      if ((!localParent || localParent.info.origin === "remote") && (!remoteParent || remoteParent.state !== "active")) {
        this.sendError(socket, "ACCESS_DENIED", "Adoption parent must be an active local or remote principal");
        socket.end();
        return;
      }
      const newRootSessionId = localParent?.info.origin === "local" ? localParent.info.id : remoteParent.rootSessionId;
      const priorSessions = Array.from(this.sessions.values(), (session) => session.info);
      let changed;
      try {
        changed = this.accessRegistry.adoptSubtree(message.principalId, message.newParentSessionId, newRootSessionId);
      } catch {
        this.sendError(socket, "ACCESS_DENIED", "Adoption would violate the ownership tree");
        socket.end();
        return;
      }
      this.disconnectTransitionedPrincipals(changed, priorSessions, "principal_adopted");
      writeMessage(socket, {
        type: "access_control_result",
        requestId: message.requestId,
        action: "adopt_subtree",
        principals: changed.map((principal) => this.principalSummary(principal))
      });
      socket.end();
      return;
    }
    if (message.action === "revoke_subtree") {
      if (typeof message.principalId !== "string" || !isSessionId(message.principalId)) {
        this.sendError(socket, "INVALID_REQUEST", "Invalid remote principal ID");
        socket.end();
        return;
      }
      const priorSessions = Array.from(this.sessions.values(), (session) => session.info);
      const changed = this.accessRegistry.revoke(message.principalId);
      this.disconnectTransitionedPrincipals(changed, priorSessions);
      writeMessage(socket, {
        type: "access_control_result",
        requestId: message.requestId,
        action: "revoke_subtree",
        changedPrincipalIds: changed.map((principal) => principal.id)
      });
      socket.end();
      return;
    }
    if (message.action !== "issue_enrollment" || typeof message.enrollment !== "object" || message.enrollment === null || Array.isArray(message.enrollment)) {
      this.sendError(socket, "INVALID_REQUEST", "Unknown remote access control action");
      socket.end();
      return;
    }
    const enrollment = message.enrollment;
    if (typeof enrollment.name !== "string" || typeof enrollment.parentSessionId !== "string" || typeof enrollment.rootSessionId !== "string" || typeof enrollment.remoteHostId !== "string" || enrollment.ttlMs !== void 0 && (typeof enrollment.ttlMs !== "number" || !Number.isSafeInteger(enrollment.ttlMs)) || enrollment.expiresAt !== void 0 && (typeof enrollment.expiresAt !== "number" || !Number.isSafeInteger(enrollment.expiresAt)) || enrollment.canDelegate !== void 0 && typeof enrollment.canDelegate !== "boolean" || enrollment.maxDepth !== void 0 && (typeof enrollment.maxDepth !== "number" || !Number.isSafeInteger(enrollment.maxDepth)) || enrollment.maxChildren !== void 0 && (typeof enrollment.maxChildren !== "number" || !Number.isSafeInteger(enrollment.maxChildren))) {
      this.sendError(socket, "INVALID_REQUEST", "Invalid remote enrollment request");
      socket.end();
      return;
    }
    const parent = this.sessions.get(enrollment.parentSessionId);
    if (!parent || parent.info.origin === "remote" || enrollment.rootSessionId !== parent.info.id) {
      this.sendError(socket, "ACCESS_DENIED", "Enrollment parent must be an active local root session");
      socket.end();
      return;
    }
    const issued = this.accessRegistry.issueEnrollment({
      name: enrollment.name,
      parentSessionId: parent.info.id,
      rootSessionId: parent.info.id,
      remoteHostId: enrollment.remoteHostId,
      ...enrollment.expiresAt !== void 0 ? { expiresAt: enrollment.expiresAt } : {},
      ...enrollment.canDelegate !== void 0 ? { canDelegate: enrollment.canDelegate } : {},
      ...enrollment.maxDepth !== void 0 ? { maxDepth: enrollment.maxDepth } : {},
      ...enrollment.maxChildren !== void 0 ? { maxChildren: enrollment.maxChildren } : {}
    }, enrollment.ttlMs);
    this.audit.record({
      event: "enrollment_issued",
      outcome: "allowed",
      actorId: parent.info.id,
      targetId: enrollment.name,
      remoteHostId: enrollment.remoteHostId,
      reason: `expires:${issued.expiresAt}`
    });
    writeMessage(socket, {
      type: "access_control_result",
      requestId: message.requestId,
      action: "issue_enrollment",
      enrollmentToken: issued.enrollmentToken,
      expiresAt: issued.expiresAt
    });
    socket.end();
  }
  handleRemoteAccessControl(socket, message) {
    if (typeof message.requestId !== "string" || message.requestId.length > MAX_MESSAGE_ID_LENGTH || typeof message.access !== "object" || message.access === null || Array.isArray(message.access)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote control request was rejected");
      socket.end();
      return;
    }
    const access = message.access;
    if (typeof access.sessionCredential !== "string" || typeof access.sessionId !== "string" || typeof access.generation !== "number" || !Number.isSafeInteger(access.generation)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote control credential was rejected");
      socket.end();
      return;
    }
    let parent;
    try {
      parent = this.accessRegistry.authenticateSession(access.sessionId, access.generation, access.sessionCredential);
    } catch {
      this.audit.tryRecord({ event: "remote_registration_denied", outcome: "denied", reason: "INVALID_CONTROL_CREDENTIAL" });
      this.sendError(socket, "ACCESS_DENIED", "Remote control credential was rejected");
      socket.end();
      return;
    }
    const policyState = this.registryPolicyState();
    if (message.action === "inspect_tree") {
      const targetId = typeof message.principalId === "string" ? message.principalId : parent.id;
      const inspection = authorize(policyState, parent.id, "inspect_tree", targetId, { actorGeneration: parent.generation });
      if (!inspection.allowed) {
        this.sendError(socket, "ACCESS_DENIED", "Remote tree inspection policy denied the request");
        socket.end();
        return;
      }
      const principals = this.accessRegistry.inspectSubtree(targetId).filter((candidate) => authorize(policyState, parent.id, "inspect_tree", candidate.id, { actorGeneration: parent.generation }).allowed).map((candidate) => this.principalSummary(candidate));
      this.audit.record({
        event: "tree_inspected",
        outcome: "allowed",
        actorId: parent.id,
        targetId,
        remoteHostId: parent.remoteHostId,
        generation: parent.generation,
        visibleCount: principals.length
      });
      writeMessage(socket, { type: "access_control_result", requestId: message.requestId, action: "inspect_tree", principals });
      socket.end();
      return;
    }
    if (message.action !== "issue_child_enrollment" || typeof message.enrollment !== "object" || message.enrollment === null || Array.isArray(message.enrollment)) {
      this.sendError(socket, "ACCESS_DENIED", "Remote control action was rejected");
      socket.end();
      return;
    }
    const enrollment = message.enrollment;
    if (typeof enrollment.name !== "string" || enrollment.ttlMs !== void 0 && (typeof enrollment.ttlMs !== "number" || !Number.isSafeInteger(enrollment.ttlMs)) || enrollment.expiresAt !== void 0 && (typeof enrollment.expiresAt !== "number" || !Number.isSafeInteger(enrollment.expiresAt)) || enrollment.canDelegate !== void 0 && typeof enrollment.canDelegate !== "boolean" || enrollment.maxDepth !== void 0 && (typeof enrollment.maxDepth !== "number" || !Number.isSafeInteger(enrollment.maxDepth)) || enrollment.maxChildren !== void 0 && (typeof enrollment.maxChildren !== "number" || !Number.isSafeInteger(enrollment.maxChildren))) {
      this.sendError(socket, "ACCESS_DENIED", "Remote delegation request was rejected");
      socket.end();
      return;
    }
    const delegation = authorize(policyState, parent.id, "delegate_child", parent.id, {
      actorGeneration: parent.generation,
      targetGeneration: parent.generation
    });
    if (!delegation.allowed) {
      this.sendError(socket, "ACCESS_DENIED", "Remote delegation policy denied the request");
      socket.end();
      return;
    }
    let issued;
    try {
      issued = this.accessRegistry.issueChildEnrollment(parent.id, parent.generation, {
        name: enrollment.name,
        ...enrollment.expiresAt !== void 0 ? { expiresAt: enrollment.expiresAt } : {},
        ...enrollment.canDelegate !== void 0 ? { canDelegate: enrollment.canDelegate } : {},
        ...enrollment.maxDepth !== void 0 ? { maxDepth: enrollment.maxDepth } : {},
        ...enrollment.maxChildren !== void 0 ? { maxChildren: enrollment.maxChildren } : {}
      }, enrollment.ttlMs);
    } catch {
      this.sendError(socket, "ACCESS_DENIED", "Remote delegation limits denied the request");
      socket.end();
      return;
    }
    this.audit.record({
      event: "enrollment_issued",
      outcome: "allowed",
      actorId: parent.id,
      targetId: enrollment.name,
      remoteHostId: parent.remoteHostId,
      generation: parent.generation,
      reason: `delegated-expires:${issued.expiresAt}`
    });
    writeMessage(socket, {
      type: "access_control_result",
      requestId: message.requestId,
      action: "issue_child_enrollment",
      enrollmentToken: issued.enrollmentToken,
      expiresAt: issued.expiresAt,
      parentSessionId: parent.id
    });
    socket.end();
  }
  registryPolicyState() {
    const records = this.accessRegistry.snapshot().principals;
    const principals = {};
    for (const record of Object.values(records)) {
      principals[record.id] = {
        id: record.id,
        kind: "remote",
        state: record.state,
        generation: record.generation,
        policy: "remote-tree",
        parentSessionId: record.parentSessionId,
        rootSessionId: record.rootSessionId
      };
      if (!principals[record.rootSessionId]) {
        principals[record.rootSessionId] = {
          id: record.rootSessionId,
          kind: "local",
          state: "active",
          generation: 1,
          policy: "local-public",
          rootSessionId: record.rootSessionId
        };
      }
    }
    return { principals };
  }
  principalSummary(principal) {
    return { ...principal, connected: this.sessions.has(principal.id) };
  }
  reconcileExpiredPrincipals() {
    const priorSessions = Array.from(this.sessions.values(), (session) => session.info);
    const changed = this.accessRegistry.expirePrincipals();
    if (changed.length > 0) this.disconnectTransitionedPrincipals(changed, priorSessions, "principal_expired");
  }
  disconnectTransitionedPrincipals(changed, priorSessions, auditEvent = "principal_revoked") {
    const changedIds = new Set(changed.map((principal) => principal.id));
    for (const principal of changed) {
      const live = this.sessions.get(principal.id);
      if (!live) {
        this.audit.record({
          event: auditEvent,
          outcome: "allowed",
          actorId: principal.id,
          remoteHostId: principal.remoteHostId,
          generation: principal.generation,
          reason: "OFFLINE"
        });
        continue;
      }
      const subject = priorSessions.find((session) => session.id === principal.id) ?? live.info;
      for (const [recipientId, recipient] of this.sessions) {
        if (recipientId !== principal.id && !changedIds.has(recipientId) && authorizeSessionAction(priorSessions, recipientId, "discover", principal.id).allowed && sameIntercomScope(recipient.scopeId, live.scopeId)) {
          writeMessage(recipient.socket, { type: "session_left", sessionId: principal.id });
        }
      }
      this.clearPendingDeliveriesForSession(principal.id, live.socket);
      this.clearAskEdgesForSession(principal.id, "authorization_revoked");
      this.sessions.delete(principal.id);
      for (const [key, recent] of this.recentDeliveries) {
        if (recent.from === principal.id || recent.to === principal.id) this.recentDeliveries.delete(key);
      }
      this.audit.record({
        event: auditEvent,
        outcome: "allowed",
        actorId: principal.id,
        targetId: subject.parentSessionId,
        remoteHostId: principal.remoteHostId,
        generation: principal.generation,
        reason: "DISCONNECTED"
      });
      live.socket.destroy();
    }
    if (changed.length > 0) this.scheduleShutdownCheck();
  }
  isCurrentPrincipal(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.info.origin !== "remote") return true;
    try {
      this.accessRegistry.validatePrincipal(sessionId, session.info.generation ?? 0);
      return true;
    } catch {
      return false;
    }
  }
  isAuthorized(actorId, action, targetId, bossContext) {
    if (!this.isCurrentPrincipal(actorId) || !this.isCurrentPrincipal(targetId)) return false;
    return authorizeSessionAction(
      Array.from(this.sessions.values(), (session) => session.info),
      actorId,
      action,
      targetId,
      bossContext
    ).allowed;
  }
  broadcastLifecycle(message, subject, exclude) {
    for (const [id, session] of this.sessions) {
      if (id !== exclude && sameIntercomScope(session.scopeId, subject.scopeId) && this.isAuthorized(id, "discover", subject.info.id)) {
        writeMessage(session.socket, message);
      }
    }
  }
  askKey(fromSessionId, messageId) {
    return `${fromSessionId}\0${messageId}`;
  }
  deliveryKey(fromSessionId, messageId) {
    return `${fromSessionId}\0${messageId}`;
  }
  addAskEdge(messageId, from, to) {
    const key = this.askKey(from, messageId);
    const previous = this.askEdges.get(key);
    if (previous) {
      clearTimeout(previous.timeout);
    }
    const createdAt = Date.now();
    const expiresAt = createdAt + this.askTimeoutMs;
    this.askEdges.set(key, {
      messageId,
      from,
      to,
      createdAt,
      expiresAt,
      state: "blocking",
      timeout: this.scheduleAskExpiry(key, expiresAt)
    });
    this.persistAskEdges();
  }
  removeAskEdge(key, reason, notifyRecipient = false) {
    const edge = this.askEdges.get(key);
    if (!edge) {
      return;
    }
    clearTimeout(edge.timeout);
    this.askEdges.delete(key);
    this.persistAskEdges();
    if (reason && notifyRecipient) {
      this.notifyAskCancelled(edge.to, edge.messageId, edge.from, reason);
    }
  }
  notifyAskDeferred(edge) {
    const recipient = this.sessions.get(edge.to);
    if (recipient) {
      writeMessage(recipient.socket, {
        type: "ask_deferred",
        messageId: edge.messageId,
        fromSessionId: edge.from
      });
    }
  }
  notifyAskCancelled(sessionId, messageId, fromSessionId, reason) {
    const session = this.sessions.get(sessionId);
    if (session) {
      writeMessage(session.socket, { type: "ask_cancelled", messageId, fromSessionId, reason });
    }
  }
  clearAskEdgesForSession(sessionId, reason) {
    let changed = false;
    for (const [key, edge] of this.askEdges) {
      if (edge.from === sessionId || edge.to === sessionId) {
        clearTimeout(edge.timeout);
        this.askEdges.delete(key);
        changed = true;
        if (edge.from === sessionId) {
          this.notifyAskCancelled(edge.to, edge.messageId, edge.from, reason);
        } else {
          this.notifyAskCancelled(edge.from, edge.messageId, edge.to, reason);
        }
      }
    }
    if (changed) {
      this.persistAskEdges();
    }
  }
  deferAskEdgesForSession(sessionId) {
    let changed = false;
    for (const edge of this.askEdges.values()) {
      if ((edge.from === sessionId || edge.to === sessionId) && edge.state === "blocking") {
        edge.state = "deferred";
        changed = true;
        if (edge.from === sessionId) {
          this.notifyAskDeferred(edge);
        }
      }
    }
    if (changed) {
      this.persistAskEdges();
    }
  }
  scheduleAskExpiry(key, expiresAt) {
    const delay = Math.max(1, Math.min(expiresAt - Date.now(), 2147483647));
    const timeout = setTimeout(() => {
      if (expiresAt > Date.now()) {
        const edge = this.askEdges.get(key);
        if (edge) {
          clearTimeout(edge.timeout);
          edge.timeout = this.scheduleAskExpiry(key, expiresAt);
        }
        return;
      }
      this.removeAskEdge(key, "expired", true);
    }, delay);
    timeout.unref?.();
    return timeout;
  }
  loadAskEdges() {
    if (!existsSync3(ASK_STATE_PATH)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync5(ASK_STATE_PATH, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("expected an object");
      }
      const state = parsed;
      if (state.version !== 1) {
        throw new Error("unsupported state version");
      }
      const edges = state.edges;
      if (!Array.isArray(edges)) {
        throw new Error("expected an edges array");
      }
      const now = Date.now();
      for (const candidate of edges) {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
          continue;
        }
        const edge = candidate;
        if (typeof edge.messageId !== "string" || edge.messageId.length === 0 || edge.messageId.length > MAX_MESSAGE_ID_LENGTH || !isSessionId(edge.from) || !isSessionId(edge.to) || typeof edge.createdAt !== "number" || !Number.isFinite(edge.createdAt) || typeof edge.expiresAt !== "number" || !Number.isFinite(edge.expiresAt) || edge.expiresAt <= now || edge.state !== "blocking" && edge.state !== "deferred") {
          continue;
        }
        const key = this.askKey(edge.from, edge.messageId);
        this.askEdges.set(key, {
          messageId: edge.messageId,
          from: edge.from,
          to: edge.to,
          createdAt: edge.createdAt,
          expiresAt: edge.expiresAt,
          state: "deferred",
          timeout: this.scheduleAskExpiry(key, edge.expiresAt)
        });
      }
      this.persistAskEdges();
    } catch (error) {
      console.error(`Failed to load persisted ask state at ${ASK_STATE_PATH}:`, error);
      for (const edge of this.askEdges.values()) {
        clearTimeout(edge.timeout);
      }
      this.askEdges.clear();
      try {
        const corruptPath = `${ASK_STATE_PATH}.corrupt-${Date.now()}`;
        renameSync3(ASK_STATE_PATH, corruptPath);
        restrictIntercomRuntimeFile(corruptPath);
      } catch {
      }
    }
  }
  persistAskEdges() {
    const edges = Array.from(this.askEdges.values(), (edge) => ({
      messageId: edge.messageId,
      from: edge.from,
      to: edge.to,
      createdAt: edge.createdAt,
      expiresAt: edge.expiresAt,
      state: edge.state
    }));
    writeDurableJson(ASK_STATE_PATH, { version: 1, edges });
  }
  countAskEdgesFrom(sessionId) {
    let count = 0;
    for (const edge of this.askEdges.values()) {
      if (edge.from === sessionId) {
        count += 1;
      }
    }
    return count;
  }
  countPendingDeliveriesFrom(sessionId) {
    let count = 0;
    for (const delivery of this.pendingDeliveries.values()) {
      if (delivery.from === sessionId) {
        count += 1;
      }
    }
    return count;
  }
  bossControlKey(fromSessionId, envelope) {
    return canonicalHash("agent-intercom-codex/boss-control/idempotency-scope/v1", {
      fromSessionId,
      bossRunId: envelope.bossRunId,
      participantId: envelope.participantId,
      bindingEpoch: Number(envelope.bindingEpoch),
      idempotencyKey: envelope.idempotencyKey
    });
  }
  bossControlFingerprint(toSessionId, envelope) {
    const { messageId: _transportMessageId, ...stableEnvelope } = envelope;
    return canonicalHash("agent-intercom-codex/boss-control/request/v1", { toSessionId, envelope: stableEnvelope });
  }
  acknowledgePendingBossControl(deliveryId, messageId, idempotencyKey, sessionId, socket) {
    const pending = this.pendingBossControls.get(deliveryId);
    if (!pending || pending.to !== sessionId || pending.recipientSocket !== socket || pending.messageId !== messageId || pending.envelope.idempotencyKey !== idempotencyKey) return;
    const sender = this.sessions.get(pending.from);
    const recipient = this.sessions.get(pending.to);
    const { controlKind } = bossControlKind(pending.envelope);
    if (!sender || !recipient || !authorizeSessionAction(
      Array.from(this.sessions.values(), (session) => session.info),
      pending.from,
      "control",
      pending.to,
      { controlKind, correlated: hasAuthoritativeBossControlCorrelation() }
    ).allowed) {
      this.failPendingBossControl(deliveryId, "POLICY_DENIED", "Boss control authorization changed before acknowledgement");
      return;
    }
    if (sender.socket === pending.senderSocket) {
      const result = {
        type: "boss_control_result",
        requestId: pending.requestId,
        messageId: pending.messageId,
        idempotencyKey: pending.envelope.idempotencyKey,
        status: "delivered",
        deliveryId,
        delivered: true
      };
      this.bossControlLedger.recordTerminal(pending.key, pending.fingerprint, result);
      clearTimeout(pending.timeout);
      this.pendingBossControls.delete(deliveryId);
      this.pendingBossControlKeys.delete(pending.key);
      writeMessage(sender.socket, result);
    }
  }
  failPendingBossControl(deliveryId, code, reason) {
    const pending = this.pendingBossControls.get(deliveryId);
    if (!pending) return;
    const sender = this.sessions.get(pending.from);
    const result = {
      type: "boss_control_result",
      requestId: pending.requestId,
      messageId: pending.messageId,
      idempotencyKey: pending.envelope.idempotencyKey,
      status: "rejected",
      delivered: false,
      code,
      reason,
      deliveryId
    };
    this.bossControlLedger.recordTerminal(pending.key, pending.fingerprint, result);
    clearTimeout(pending.timeout);
    this.pendingBossControls.delete(deliveryId);
    this.pendingBossControlKeys.delete(pending.key);
    if (sender?.socket === pending.senderSocket) writeMessage(sender.socket, result);
  }
  clearPendingBossControlsForSession(sessionId, socket) {
    for (const pending of Array.from(this.pendingBossControls.values())) {
      if (pending.to === sessionId && pending.recipientSocket === socket) {
        this.failPendingBossControl(pending.deliveryId, "RECIPIENT_DISCONNECTED", "Boss control recipient disconnected before acknowledgement");
      } else if (pending.from === sessionId && pending.senderSocket === socket) {
        clearTimeout(pending.timeout);
        this.pendingBossControls.delete(pending.deliveryId);
        this.pendingBossControlKeys.delete(pending.key);
      }
    }
  }
  acknowledgePendingDelivery(deliveryId, sessionId, socket) {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending || pending.to !== sessionId || pending.recipientSocket !== socket) {
      return;
    }
    const sender = this.sessions.get(pending.from);
    const recipient = this.sessions.get(pending.to);
    if (!sender || !recipient || (sender.info.generation ?? 1) !== pending.fromGeneration || (recipient.info.generation ?? 1) !== pending.toGeneration || !this.isAuthorized(pending.from, pending.action, pending.to)) {
      this.failPendingDelivery(deliveryId, "SESSION_NOT_FOUND", "Delivery authorization changed before acknowledgement");
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingDeliveries.delete(deliveryId);
    this.pendingDeliveryKeys.delete(pending.key);
    if (pending.message.replyTo) {
      this.removeAskEdge(this.askKey(pending.to, pending.message.replyTo));
    }
    const response = { type: "delivered", messageId: pending.message.id, deliveryId };
    this.recentDeliveries.set(pending.key, {
      fingerprint: pending.fingerprint,
      from: pending.from,
      to: pending.to,
      action: pending.action,
      fromGeneration: pending.fromGeneration,
      toGeneration: pending.toGeneration,
      retryable: false,
      response,
      expiresAt: Date.now() + RECENT_DELIVERY_TTL_MS
    });
    if (sender.socket === pending.senderSocket) {
      writeMessage(sender.socket, response);
    }
  }
  failPendingDelivery(deliveryId, code, reason) {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingDeliveries.delete(deliveryId);
    this.pendingDeliveryKeys.delete(pending.key);
    if (pending.message.expectsReply) {
      this.removeAskEdge(this.askKey(pending.from, pending.message.id), "delivery_failed", true);
    }
    const response = {
      type: "delivery_failed",
      messageId: pending.message.id,
      accepted: true,
      code,
      reason
    };
    this.recentDeliveries.set(pending.key, {
      fingerprint: pending.fingerprint,
      from: pending.from,
      to: pending.to,
      action: pending.action,
      fromGeneration: pending.fromGeneration,
      toGeneration: pending.toGeneration,
      retryable: true,
      response,
      expiresAt: Date.now() + RECENT_DELIVERY_TTL_MS
    });
    const sender = this.sessions.get(pending.from);
    if (sender?.socket === pending.senderSocket) {
      writeMessage(sender.socket, response);
    }
  }
  clearPendingDeliveriesForSession(sessionId, socket) {
    this.clearPendingBossControlsForSession(sessionId, socket);
    for (const delivery of Array.from(this.pendingDeliveries.values())) {
      if (delivery.to === sessionId && delivery.recipientSocket === socket) {
        this.failPendingDelivery(delivery.id, "RECIPIENT_DISCONNECTED", "Recipient disconnected before acknowledging the message");
      } else if (delivery.from === sessionId && delivery.senderSocket === socket) {
        this.failPendingDelivery(delivery.id, "SENDER_DISCONNECTED", "Sender disconnected before delivery was acknowledged");
      }
    }
  }
  pruneRecentDeliveries(now = Date.now()) {
    for (const [key, delivery] of this.recentDeliveries) {
      if (delivery.expiresAt <= now) {
        this.recentDeliveries.delete(key);
      }
    }
  }
  findSessions(actorId, nameOrId) {
    const byId = this.sessions.get(nameOrId);
    if (byId) return [byId];
    const actor = this.sessions.get(actorId);
    if (!actor) return [];
    const sameScope = Array.from(this.sessions.values()).filter(
      (session) => sameIntercomScope(actor.scopeId, session.scopeId)
    );
    const lowerName = nameOrId.toLowerCase();
    const byName = sameScope.filter((session) => session.info.name?.toLowerCase() === lowerName);
    if (byName.length > 0) return byName;
    return sameScope.filter((session) => session.info.id.startsWith(nameOrId));
  }
  shutdown() {
    console.log("Broker shutting down");
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    for (const delivery of this.pendingDeliveries.values()) {
      clearTimeout(delivery.timeout);
    }
    this.pendingDeliveries.clear();
    this.pendingDeliveryKeys.clear();
    for (const pending of this.pendingBossControls.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingBossControls.clear();
    this.pendingBossControlKeys.clear();
    for (const edge of this.askEdges.values()) {
      clearTimeout(edge.timeout);
    }
    this.askEdges.clear();
    const ownsBroker = hasBrokerOwnership(OWNER_PATH);
    if (ownsBroker && typeof LISTEN_TARGET === "string" && process.platform !== "win32") {
      for (const socketPath of [LISTEN_TARGET, REMOTE_LISTEN_TARGET]) {
        try {
          unlinkSync2(socketPath);
        } catch {
        }
      }
    }
    if (ownsBroker) {
      try {
        unlinkSync2(PORT_PATH);
      } catch {
      }
      try {
        unlinkSync2(PID_PATH);
      } catch {
      }
      releaseBrokerOwnership(OWNER_PATH);
    }
    this.server.close();
    this.remoteServer?.close();
    process.exit(0);
  }
};
new IntercomBroker().start();
