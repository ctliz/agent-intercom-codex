#!/usr/bin/env node
process.stderr.write("[agent-intercom-build] package=@ctliz/agent-intercom-codex version=0.12.0-connect.3 target=codex-server sourceSha256=d7208ae5db4e820dfc584a6a8a4a96f5ccf548f20872199024f6d4c955f85622\n");

// codex/server.ts
import readline from "node:readline";
import { stdin, stdout } from "node:process";

// codex/runtime.ts
import { randomUUID as randomUUID4, createHash as createHash3 } from "crypto";
import { spawnSync } from "child_process";
import { basename } from "path";
import { cwd as processCwd } from "process";

// broker/client.ts
import { EventEmitter } from "events";
import net from "net";
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
    } catch (error2) {
      const message = error2 instanceof Error ? error2.message : String(error2);
      onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error2 }));
      return false;
    }
    try {
      onMessage(msg);
      return true;
    } catch (error2) {
      const message = error2 instanceof Error ? error2.message : String(error2);
      onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error2 }));
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

// outbound-outbox.ts
import { createHash } from "crypto";
import { chmodSync as chmodSync2, existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2 } from "fs";
import { join as join2 } from "path";

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
  return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}
var PersistentOutboundOutbox = class {
  directory;
  filePath;
  state;
  constructor(sessionId, intercomDir = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    this.directory = join2(intercomDir, "outbox");
    mkdirSync2(this.directory, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync2(this.directory, INTERCOM_DIR_MODE);
    this.filePath = join2(this.directory, fileName(sessionId));
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
    if (!existsSync(this.filePath)) return { version: OUTBOX_STATE_VERSION, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync2(this.filePath, "utf-8"));
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
import { createHash as createHash2 } from "node:crypto";
import { chmodSync as chmodSync3, existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync3 } from "node:fs";
import { join as join3 } from "node:path";
import { canonicalHash } from "@ctliz/agent-intercom-core/canonical";
import { parseBossControlEnvelope as parseBossControlEnvelope2 } from "@ctliz/agent-intercom-core/boss";

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

// boss-control-outbox.ts
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
  return `${createHash2("sha256").update(sessionId).digest("hex")}.json`;
}
var PersistentBossControlOutbox = class {
  path;
  state;
  constructor(sessionId, intercomDir = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    const directory = join3(intercomDir, "boss-control-outbox");
    mkdirSync3(directory, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync3(directory, INTERCOM_DIR_MODE);
    this.path = join3(directory, fileName2(sessionId));
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
    if (!existsSync2(this.path)) return { version: BOSS_CONTROL_OUTBOX_VERSION, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync3(this.path, "utf8"));
      assertBossCanonicalData(parsed, "$.bossControlOutbox");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed;
      if (!exactKeys(state, ["version", "entries"]) || state.version !== BOSS_CONTROL_OUTBOX_VERSION || !Array.isArray(state.entries)) {
        throw new Error("invalid Boss outbox state");
      }
      return { version: BOSS_CONTROL_OUTBOX_VERSION, entries: state.entries.map(parseEntry) };
    } catch (error2) {
      const corruptPath = `${this.path}.corrupt-${Date.now()}`;
      renameSync3(this.path, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      throw new Error(`Boss control outbox was corrupt and quarantined at ${corruptPath}`, { cause: error2 });
    }
  }
  persist() {
    writeDurableJson(this.path, this.state);
  }
};

// broker/access-credential.ts
import { readFileSync as readFileSync4 } from "fs";
var ACCESS_CREDENTIAL_ENV = "AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH";
var ACCESS_CREDENTIAL_VERSION = 1;
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
function loadRemoteAccessCredential(env = process.env) {
  const path = env[ACCESS_CREDENTIAL_ENV]?.trim();
  if (!path) return void 0;
  const parsed = JSON.parse(readFileSync4(path, "utf8"));
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
import { types as nodeUtilTypes2 } from "node:util";
function toError(error2) {
  return error2 instanceof Error ? error2 : new Error(String(error2));
}
function connectToBrokerTarget(target) {
  return typeof target === "string" ? net.connect(target) : net.connect({ host: target.host, port: target.port });
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
var IntercomClient = class extends EventEmitter {
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
  failPending(error2) {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error2);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error2);
    }
    this.pendingLists.clear();
    for (const pending of this.pendingAskControls.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingAskControls.clear();
    for (const pending of this.pendingBossControls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error2);
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
        ...typeof session === "object" && session !== null && !nodeUtilTypes2.isProxy(session) && Object.getOwnPropertyDescriptor(session, "boss") !== void 0 ? { registrationKind: "boss" } : {},
        protocol: INTERCOM_PROTOCOL_NAME2,
        version: INTERCOM_PROTOCOL_VERSION2,
        session
      }).session;
      this.requestedBossRegistration = session.boss === void 0 ? void 0 : parseBossParticipantRegistrationMetadata(session.boss);
      if (canonicalSession !== session) throw new Error("Registration session identity changed during validation");
    } catch (error2) {
      return Promise.reject(toError(error2));
    }
    return new Promise((resolve3, reject) => {
      let socket;
      let target;
      try {
        target = getBrokerConnectTarget();
        this.remoteAccessCredential = loadRemoteAccessCredential();
        socket = connectToBrokerTarget(target);
      } catch (error2) {
        reject(toError(error2));
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
        resolve3();
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
      const onReaderError = (error2) => {
        const protocolError = new Error(`Intercom protocol error: ${error2.message}`, { cause: error2 });
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
          protocol: INTERCOM_PROTOCOL_NAME2,
          version: INTERCOM_PROTOCOL_VERSION2,
          session,
          ...!this.remoteAccessCredential && sessionId ? { sessionId } : {},
          ...this.remoteAccessCredential ? { access: this.remoteAccessCredential.access } : {},
          ...this.scopeId ? { scopeId: this.scopeId } : {},
          ...typeof target === "string" ? {} : { stateId: target.stateId }
        });
      } catch (error2) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error2));
      }
    });
  }
  handleBrokerMessage(msg) {
    if (typeof msg !== "object" || msg === null || nodeUtilTypes2.isProxy(msg)) {
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
        if (typeof brokerMessage.sessionId !== "string" || brokerMessage.protocol !== INTERCOM_PROTOCOL_NAME2 || brokerMessage.version !== INTERCOM_PROTOCOL_VERSION2) {
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
          const error3 = new Error(brokerMessage.error);
          error3.code = brokerMessage.code;
          throw error3;
        }
        const error2 = new Error(brokerMessage.error);
        error2.code = brokerMessage.code;
        this.emit("error", error2);
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
    await new Promise((resolve3) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve3();
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
    } catch (error2) {
      return Promise.reject(toError(error2));
    }
    return new Promise((resolve3, reject) => {
      const requestId = randomUUID2();
      const wrappedResolve = (sessions) => {
        clearTimeout(timeout);
        resolve3(sessions);
      };
      const wrappedReject = (error2) => {
        clearTimeout(timeout);
        reject(error2);
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
      } catch (error2) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error2));
      }
    });
  }
  send(to, options) {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error2) {
      return Promise.reject(toError(error2));
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
    } catch (error2) {
      return Promise.reject(toError(error2));
    }
    return new Promise((resolve3, reject) => {
      const wrappedResolve = (result) => {
        clearTimeout(timeout);
        resolve3(result);
      };
      const wrappedReject = (error2) => {
        clearTimeout(timeout);
        reject(error2);
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
      } catch (error2) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error2));
      }
    });
  }
  sendBossControl(to, envelopeValue) {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error2) {
      return Promise.reject(toError(error2));
    }
    let envelope;
    try {
      envelope = bossControlKind(envelopeValue).envelope;
      const binding = this._bossBinding?.binding;
      if (binding === void 0 || binding.state !== "active" || envelope.bossRunId !== binding.bossRunId || envelope.participantId !== binding.participantId || envelope.bindingEpoch !== binding.bindingEpoch) throw new Error("Boss control envelope does not match this client's active participant binding");
    } catch (error2) {
      return Promise.reject(toError(error2));
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
    } catch (error2) {
      return Promise.reject(toError(error2));
    }
    return new Promise((resolve3, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingBossControls.delete(requestId)) return;
        reject(new Error("Boss control delivery timeout"));
      }, 1e4);
      timeout.unref?.();
      this.pendingBossControls.set(requestId, {
        messageId: envelope.messageId,
        idempotencyKey: envelope.idempotencyKey,
        resolve: resolve3,
        reject,
        timeout
      });
      try {
        writeMessage(socket, { type: "boss_control", requestId, to, envelope });
      } catch (error2) {
        clearTimeout(timeout);
        this.pendingBossControls.delete(requestId);
        reject(toError(error2));
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
    return new Promise((resolve3) => {
      const timeout = setTimeout(() => {
        this.pendingAskControls.delete(requestId);
        resolve3(false);
      }, 2e3);
      timeout.unref?.();
      this.pendingAskControls.set(requestId, { resolve: resolve3, timeout });
      if (!this.writeControlMessage({ type: action === "defer" ? "defer_ask" : "cancel_ask", requestId, messageId })) {
        clearTimeout(timeout);
        this.pendingAskControls.delete(requestId);
        resolve3(false);
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
import { spawn } from "child_process";
import { existsSync as existsSync3, readFileSync as readFileSync5, unlinkSync, writeFileSync as writeFileSync2 } from "fs";
import { join as join4, dirname as dirname2 } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net2 from "net";
import { randomUUID as randomUUID3 } from "crypto";
import { POLICY_SEMANTICS_HASH as POLICY_SEMANTICS_HASH2, POLICY_SEMANTICS_VERSION as POLICY_SEMANTICS_VERSION2 } from "@ctliz/agent-intercom-core";
var INTERCOM_DIR = getIntercomDirPath();
var EXTENSION_DIR = join4(dirname2(fileURLToPath(import.meta.url)), "..");
var BROKER_PID = join4(INTERCOM_DIR, "broker.pid");
var BROKER_SPAWN_LOCK = join4(INTERCOM_DIR, "broker.spawn.lock");
function sleep(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function getBrokerEntryPath(moduleUrl = import.meta.url) {
  const moduleDir = dirname2(fileURLToPath(moduleUrl));
  const bundledBroker = join4(moduleDir, "broker.mjs");
  return existsSync3(bundledBroker) ? bundledBroker : join4(moduleDir, "broker.ts");
}
function getTsxCliPath(extensionDir = EXTENSION_DIR) {
  try {
    const requireFromExtension = createRequire(import.meta.url);
    const tsxMain = requireFromExtension.resolve("tsx");
    return join4(dirname2(tsxMain), "cli.mjs");
  } catch {
    return join4(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
  }
}
function quoteWindowsArg(value) {
  return `"${value.replace(/"/g, '""')}"`;
}
function getWindowsHiddenLauncherPath(intercomDir = INTERCOM_DIR) {
  return join4(intercomDir, "broker-launch.vbs");
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
  if (response.type !== "health_ok" || response.requestId !== requestId || response.protocol !== INTERCOM_PROTOCOL_NAME2 || response.version !== INTERCOM_PROTOCOL_VERSION2 || response.endpoint !== "local") return false;
  const remoteAccess = response.remoteAccess;
  if (typeof remoteAccess !== "object" || remoteAccess === null || Array.isArray(remoteAccess)) return false;
  const contract = remoteAccess;
  return contract.feature === "remote-access-v1" && contract.policySemanticsVersion === POLICY_SEMANTICS_VERSION2 && contract.policySemanticsHash === POLICY_SEMANTICS_HASH2;
}
function writeWindowsHiddenLauncher(commandLine, launcherPath = getWindowsHiddenLauncherPath()) {
  ensureIntercomRuntimeDir(dirname2(launcherPath));
  writeFileSync2(launcherPath, getWindowsHiddenLauncherScript(commandLine), {
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
    windowsHide: true,
    shell: false
  };
}
function toError2(error2) {
  return error2 instanceof Error ? error2 : new Error(String(error2));
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
      throw new Error(`Incompatible live intercom broker; expected ${INTERCOM_PROTOCOL_NAME2} v${INTERCOM_PROTOCOL_VERSION2}. Stop it explicitly during a coordinated migration.`);
    }
    const brokerPath = getBrokerEntryPath();
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    const child = spawn(launch.command, launch.args, getBrokerSpawnOptions());
    child.unref();
    await new Promise((resolve3, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error2) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error2.message}`, { cause: error2 }));
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
        resolve3();
      }, (error2) => {
        cleanup();
        reject(toError2(error2));
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
  if (!existsSync3(BROKER_PID)) return false;
  try {
    const pid = parseInt(readFileSync5(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    return false;
  }
}
function connectToBrokerTarget2(target) {
  return typeof target === "string" ? net2.connect(target) : net2.connect({ host: target.host, port: target.port });
}
async function checkSocketConnectable() {
  return await checkBrokerHealth() === "compatible";
}
function checkBrokerHealth() {
  return new Promise((resolve3) => {
    let target;
    try {
      target = getBrokerConnectTarget();
    } catch {
      resolve3("unreachable");
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
      resolve3(health);
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
      writeFileSync2(BROKER_SPAWN_LOCK, `${process.pid}
${Date.now()}
`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE
      });
      restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
      return true;
    } catch (error2) {
      if (!(error2 instanceof Error) || error2.code !== "EEXIST") {
        throw error2;
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
  if (!existsSync3(BROKER_SPAWN_LOCK)) {
    return false;
  }
  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync5(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
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
import { existsSync as existsSync4, readFileSync as readFileSync6 } from "fs";
import { join as join5, resolve as resolve2 } from "path";
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
function getAskTimeoutMs() {
  const raw = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }
  const value = Number(raw);
  return validateAskTimeoutMs(value, "PI_INTERCOM_ASK_TIMEOUT_MS");
}
function getConfigPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve2(process.env.PI_CODING_AGENT_DIR) : join5(homedir2(), ".pi", "agent");
  return join5(agentDir, "intercom", "config.json");
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
  if (!existsSync4(configPath)) {
    return { ...defaults };
  }
  try {
    const raw = readFileSync6(configPath, "utf-8");
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
  } catch (error2) {
    console.error(`Failed to load intercom config at ${configPath}:`, error2);
    return { ...defaults };
  }
}

// codex/team.ts
import { readFile } from "node:fs/promises";
import { join as join6 } from "node:path";
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
    const parsed = JSON.parse(await readFile(join6(agentDir, "intercom", "orchestrator", "workers.json"), "utf8"));
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
function matchesPendingSender(entry, to) {
  return entry.from.id === to || entry.from.name?.toLowerCase() === to.toLowerCase() || entry.from.id.startsWith(to);
}
function selectPendingAsk(entries, to, which) {
  const sorted = [...entries].sort((a, b) => a.receivedAt - b.receivedAt);
  if (sorted.length === 0) throw new Error("No matching pending ask. Call intercom_pending to inspect unresolved asks.");
  const matches = to ? sorted.filter((entry) => matchesPendingSender(entry, to)) : sorted;
  if (matches.length === 0) throw new Error(`No pending ask from "${to}".`);
  if (matches.length === 1) return matches[0];
  if (!to && new Set(matches.map((entry) => entry.from.id)).size > 1) {
    throw new Error("Multiple pending asks \u2014 specify `to` using a sender from intercom_pending.");
  }
  if (!which) {
    const sender = to ? ` from "${to}"` : "";
    throw new Error(`Multiple pending asks${sender} \u2014 specify \`which\` as \`oldest\` or \`latest\`.`);
  }
  return which === "oldest" ? matches[0] : matches[matches.length - 1];
}
function pendingSelector(entries, entry) {
  const sameSender = entries.filter((candidate) => candidate.from.id === entry.from.id);
  if (sameSender.length <= 1) return void 0;
  const index = sameSender.findIndex((candidate) => candidate.message.id === entry.message.id);
  if (index === 0) return "oldest";
  if (index === sameSender.length - 1) return "latest";
  return "queued";
}
function publicPendingEntry(entry, selector) {
  return {
    from: {
      id: entry.from.id,
      name: entry.from.name,
      origin: entry.from.origin ?? "local",
      ...entry.from.remoteHostId ? { remote_host_id: entry.from.remoteHostId } : {},
      ...entry.from.parentSessionId ? { parent_session_id: entry.from.parentSessionId } : {},
      ...entry.from.generation ? { generation: entry.from.generation } : {}
    },
    received_at: entry.receivedAt,
    read: entry.read,
    text: entry.message.content.text,
    attachments: entry.message.content.attachments,
    expects_reply: entry.message.expectsReply,
    ...selector ? { selector } : {}
  };
}
function shortHash(value) {
  return createHash3("sha256").update(value).digest("hex").slice(0, 8);
}
var GENERIC_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
function buildCodexRuntimeIdentity(env = process.env, cwd = env.PWD || processCwd(), pid = process.pid) {
  let sessionId = env.CODEX_INTERCOM_SESSION_ID?.trim() || env.CODEX_PEER_ID?.trim();
  if (!sessionId && env.AGENT_INTERCOM_SESSION_ID !== void 0) {
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
  const name = env.CODEX_INTERCOM_NAME?.trim() || env.CODEX_PEER_NAME?.trim() || (env.AGENT_INTERCOM_SESSION_NAME !== void 0 && env.AGENT_INTERCOM_SESSION_NAME.trim() ? env.AGENT_INTERCOM_SESSION_NAME.trim() : void 0) || `codex-${cwdName}-${pid}`;
  return {
    sessionId,
    name,
    cwd,
    model: env.CODEX_INTERCOM_MODEL?.trim() || env.CODEX_MODEL?.trim() || "codex",
    startedAt: Date.now()
  };
}
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
function detectGitRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}
function textResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...structuredContent ? { structuredContent } : {},
    ...isError ? { isError: true } : {}
  };
}
var CodexIntercomRuntime = class {
  client = null;
  connectPromise = null;
  reconnectTimer = null;
  reconnectAttempt = 0;
  reconnectEnabled = true;
  identity;
  unread = [];
  unresolvedAsks = /* @__PURE__ */ new Map();
  replyWaiters = /* @__PURE__ */ new Map();
  clientFactory;
  prepareConnection;
  reconnectDelays;
  constructor(identity = buildCodexRuntimeIdentity(), options = {}) {
    this.identity = identity;
    const initialScopeId = intercomScopeIdFromEnv();
    this.clientFactory = options.clientFactory ?? (() => new IntercomClient(initialScopeId ? { scopeId: initialScopeId } : {}));
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      if (!config.enabled) throw new Error("Intercom disabled");
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.reconnectDelays = options.reconnectDelays?.length ? options.reconnectDelays : [250, 500, 1e3, 2e3, 5e3];
  }
  getIdentity() {
    return this.identity;
  }
  async connect() {
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
  async connectOnce() {
    await this.prepareConnection();
    const client = this.clientFactory();
    client.on("message", (from, message, deliveryId) => {
      this.handleIncomingMessage(from, message);
      client.acknowledgeMessage(deliveryId);
    });
    client.on("disconnected", (error2) => {
      for (const waiter of this.replyWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.reject(new Error(`Disconnected while waiting for reply: ${error2.message}`, { cause: error2 }));
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
      status: "idle"
    }, this.identity.sessionId);
    this.client = client;
    this.reconnectAttempt = 0;
    return client;
  }
  scheduleReconnect() {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)];
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
  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  async disconnect() {
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
      }
    }
    const client = this.client;
    this.client = null;
    if (client) await client.disconnect();
  }
  handleIncomingMessage(from, message) {
    const waiter = this.replyWaiters.get(message.replyTo ?? "");
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
      if (fromMatches) {
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
  waitForReply(from, replyTo, timeoutMs = getAskTimeoutMs(), signal) {
    return new Promise((resolve3, reject) => {
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
        this.replyWaiters.delete(replyTo);
        cleanup();
        void this.client?.cancelAsk(replyTo);
        reject(new Error("intercom_ask cancelled"));
      };
      timeout = setTimeout(() => {
        this.replyWaiters.delete(replyTo);
        void this.client?.deferAsk(replyTo);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1e3)} seconds`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.replyWaiters.set(replyTo, { from, replyTo, resolve: resolve3, reject, timeout, cleanup });
    });
  }
  async resolveTarget(to) {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }
  async whoami() {
    const client = await this.connect();
    const sessionId = client.sessionId ?? this.identity.sessionId;
    return textResult(
      `session_id: ${sessionId}
name: ${this.identity.name}
cwd: ${this.identity.cwd}`,
      { session_id: sessionId, name: this.identity.name, cwd: this.identity.cwd, model: this.identity.model }
    );
  }
  async team() {
    const client = await this.connect();
    const sessions = await client.listSessions();
    const team = await resolveIntercomTeam({ selfId: client.sessionId ?? this.identity.sessionId, sessions });
    return textResult(formatIntercomTeam(team), team);
  }
  async status() {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return textResult(
      `Connected: ${client.isConnected() ? "Yes" : "No"}
Session ID: ${client.sessionId ?? "unknown"}
Active sessions: ${sessions.length}
Unread messages: ${this.unread.filter((entry) => !entry.read).length}
Pending asks: ${this.unresolvedAsks.size}`,
      {
        connected: client.isConnected(),
        session_id: client.sessionId,
        active_sessions: sessions.length,
        unread_messages: this.unread.filter((entry) => !entry.read).length,
        pending_asks: this.unresolvedAsks.size
      }
    );
  }
  async list(scope2 = "machine", includeSelf = false) {
    const client = await this.connect();
    let sessions = await client.listSessions();
    if (scope2 === "directory") {
      sessions = sessions.filter((session) => session.cwd === this.identity.cwd);
    } else if (scope2 === "repo") {
      const currentRoot = detectGitRoot(this.identity.cwd);
      sessions = currentRoot ? sessions.filter((session) => detectGitRoot(session.cwd) === currentRoot) : [];
    }
    if (!includeSelf) {
      sessions = sessions.filter((session) => session.id !== client.sessionId);
    }
    return textResult(formatSessionList(sessions, client.sessionId, this.identity.cwd), { sessions });
  }
  async setSummary(summary) {
    const client = await this.connect();
    client.updatePresence({ status: summary.trim() || "idle" });
    return textResult("Summary updated.", { ok: true, summary });
  }
  async send(to, message, attachments, replyTo) {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const result = await client.send(sendTo, { text: message, attachments, replyTo });
    if (!result.delivered) {
      return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
    }
    if (replyTo) this.unresolvedAsks.delete(replyTo);
    return textResult(`Message sent to ${to}.`, { ok: true, message_id: result.id, to });
  }
  async ask(to, message, attachments, timeoutMs = getAskTimeoutMs(), signal) {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const questionId = randomUUID4();
    const replyPromise = this.waitForReply(sendTo, questionId, timeoutMs, signal);
    void replyPromise.catch(() => void 0);
    try {
      const result = await client.send(sendTo, {
        messageId: questionId,
        text: message,
        attachments,
        expectsReply: true
      });
      if (!result.delivered) {
        this.replyWaiters.get(questionId)?.reject(new Error(result.reason ?? "Session may not exist or has disconnected."));
        this.replyWaiters.delete(questionId);
        client.cancelAsk(questionId);
        return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
      }
      const reply = await replyPromise;
      const replyText = `${reply.content.text}${formatAttachments(reply.content.attachments)}`;
      return textResult(`Reply from ${to}:
${replyText}`, { ok: true, message_id: result.id, reply });
    } catch (error2) {
      client.cancelAsk(questionId);
      return textResult(error2 instanceof Error ? error2.message : String(error2), { ok: false }, true);
    }
  }
  async pending(markRead = false) {
    const unreadMessages = this.unread.filter((entry) => !entry.read);
    if (markRead) {
      for (const entry of unreadMessages) entry.read = true;
    }
    const pendingAsks = Array.from(this.unresolvedAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
    const lines = [
      unreadMessages.length ? unreadMessages.map((entry) => `- ${formatSessionDisplay(entry.from)}: ${entry.message.content.text}${formatAttachments(entry.message.content.attachments)}`).join("\n") : "No unread messages.",
      pendingAsks.length ? `
Pending asks:
${pendingAsks.map((entry) => {
        const selector = pendingSelector(pendingAsks, entry);
        return `- ${formatSessionDisplay(entry.from)}${selector ? ` [${selector}]` : ""}: ${entry.message.content.text}`;
      }).join("\n")}` : ""
    ].filter(Boolean);
    return textResult(lines.join("\n"), {
      unread_messages: unreadMessages.map((entry) => publicPendingEntry(entry)),
      pending_asks: pendingAsks.map((entry) => publicPendingEntry(entry, pendingSelector(pendingAsks, entry)))
    });
  }
  async reply(message, to, which) {
    let target;
    try {
      target = selectPendingAsk(Array.from(this.unresolvedAsks.values()), to, which);
    } catch (error2) {
      return textResult(error2 instanceof Error ? error2.message : String(error2), { ok: false }, true);
    }
    const result = await this.send(target.from.id, message, void 0, target.message.id);
    if (!result.isError) {
      this.unresolvedAsks.delete(target.message.id);
    }
    return result;
  }
};

// codex/mcp-protocol.ts
var inflightToolCalls = /* @__PURE__ */ new Map();
function asString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}
function asBoolean(value, defaultValue) {
  return typeof value === "boolean" ? value : defaultValue;
}
function asOptionalPositiveInteger(value, name) {
  if (value === void 0) return void 0;
  return validateAskTimeoutMs(value, name);
}
function asAttachmentArray(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`attachments[${index}] must be an object`);
    const raw = item;
    const type = raw.type;
    if (type !== "file" && type !== "snippet" && type !== "context") throw new Error(`attachments[${index}].type must be file, snippet, or context`);
    const name = asString(raw.name, `attachments[${index}].name`);
    const content = asString(raw.content, `attachments[${index}].content`);
    if (raw.language !== void 0 && typeof raw.language !== "string") throw new Error(`attachments[${index}].language must be a string`);
    const language = typeof raw.language === "string" ? raw.language : void 0;
    return { type, name, content, ...language ? { language } : {} };
  });
}
var attachmentsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["file", "snippet", "context"] },
      name: { type: "string" },
      content: { type: "string" },
      language: { type: "string" }
    },
    required: ["type", "name", "content"],
    additionalProperties: false
  }
};
function buildToolDefinitions(runtime2) {
  return [
    {
      name: "intercom_whoami",
      description: "Return this Codex session's intercom identity for reliable targeting.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async () => runtime2.whoami()
    },
    {
      name: "intercom_team",
      description: "Show your current manager and the live coworkers owned by that manager. No arguments are required.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async () => runtime2.team()
    },
    {
      name: "intercom_status",
      description: "Show intercom connection status, active sessions, unread messages, and pending asks.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async () => runtime2.status()
    },
    {
      name: "intercom_list",
      description: "List intercom-connected Pi or Codex sessions on this machine.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["machine", "directory", "repo"], default: "machine" },
          include_self: { type: "boolean", default: false }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args) => runtime2.list(
        args.scope === "directory" || args.scope === "repo" ? args.scope : "machine",
        asBoolean(args.include_self, false)
      )
    },
    {
      name: "intercom_set_summary",
      description: "Publish a short status summary so other sessions can discover what this Codex session is doing.",
      inputSchema: {
        type: "object",
        properties: { summary: { type: "string", maxLength: 400 } },
        required: ["summary"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      handler: async (args) => runtime2.setSummary(asString(args.summary, "summary"))
    },
    {
      name: "intercom_send",
      description: "Send a non-blocking direct message to another intercom session by name, full ID, or unique ID prefix.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          message: { type: "string" },
          attachments: attachmentsSchema
        },
        required: ["to", "message"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args) => runtime2.send(asString(args.to, "to"), asString(args.message, "message"), asAttachmentArray(args.attachments))
    },
    {
      name: "intercom_ask",
      description: "Ask another intercom session a question only when the next step depends on its reply. Use intercom_send for assignments, progress/status checkpoints, and notifications.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          message: { type: "string" },
          attachments: attachmentsSchema,
          timeout_ms: { type: "integer", minimum: 1, maximum: 12e4, description: "Maximum time to wait for a reply before returning an error. Use intercom_send plus intercom_pending for longer work." }
        },
        required: ["to", "message"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args, signal) => runtime2.ask(
        asString(args.to, "to"),
        asString(args.message, "message"),
        asAttachmentArray(args.attachments),
        asOptionalPositiveInteger(args.timeout_ms, "timeout_ms"),
        signal
      )
    },
    {
      name: "intercom_pending",
      description: "Read unread inbound messages and unresolved asks for this Codex session.",
      inputSchema: {
        type: "object",
        properties: { mark_read: { type: "boolean", default: false } },
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      handler: async (args) => runtime2.pending(asBoolean(args.mark_read, false))
    },
    {
      name: "intercom_reply",
      description: "Reply to a pending inbound ask. Use to plus which=oldest/latest when one sender has multiple unresolved asks.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          to: { type: "string", description: "Optional sender/session selector; never a message or thread ID." },
          which: { type: "string", enum: ["oldest", "latest"], description: "Select the oldest or latest ask from the chosen sender." }
        },
        required: ["message"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      handler: async (args) => runtime2.reply(asString(args.message, "message"), typeof args.to === "string" ? args.to : void 0, args.which === "oldest" || args.which === "latest" ? args.which : void 0)
    }
  ];
}
function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function error(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
async function handleMcpRequest(request, runtime2) {
  if (!request.method) {
    return error(request.id, -32600, "Invalid request");
  }
  if (request.method === "notifications/cancelled") {
    const requestId = request.params?.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      inflightToolCalls.get(requestId)?.abort();
    }
    return void 0;
  }
  if (request.id === void 0 && request.method.startsWith("notifications/")) {
    return void 0;
  }
  const tools = buildToolDefinitions(runtime2);
  switch (request.method) {
    case "initialize":
      return ok(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-intercom", version: "0.1.0" }
      });
    case "ping":
      return ok(request.id, {});
    case "tools/list":
      return ok(request.id, {
        tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))
      });
    case "tools/call": {
      const name = request.params?.name;
      const args = request.params?.arguments;
      if (typeof name !== "string") return error(request.id, -32602, "tools/call requires params.name");
      if (args !== void 0 && (!args || typeof args !== "object" || Array.isArray(args))) {
        return error(request.id, -32602, "tools/call params.arguments must be an object");
      }
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return error(request.id, -32602, `Unknown tool: ${name}`);
      const requestId = request.id;
      const abortController = typeof requestId === "string" || typeof requestId === "number" ? new AbortController() : null;
      if (abortController && requestId !== void 0) inflightToolCalls.set(requestId, abortController);
      try {
        return ok(request.id, await tool.handler(args ?? {}, abortController?.signal));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return ok(request.id, { content: [{ type: "text", text: message }], isError: true });
      } finally {
        if (abortController && requestId !== void 0) inflightToolCalls.delete(requestId);
      }
    }
    default:
      return error(request.id, -32601, `Method not found: ${request.method}`);
  }
}

// codex/server.ts
var runtime = new CodexIntercomRuntime();
var rl = readline.createInterface({
  input: stdin,
  crlfDelay: Infinity
});
var shuttingDown = false;
var pendingRequests = 0;
function writeResponse(response) {
  if (!response) return;
  stdout.write(`${JSON.stringify(response)}
`);
}
function maybeShutdown() {
  if (!shuttingDown || pendingRequests > 0) return;
  void runtime.disconnect().finally(() => process.exit(0));
}
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  pendingRequests += 1;
  void (async () => {
    try {
      const request = JSON.parse(trimmed);
      writeResponse(await handleMcpRequest(request, runtime));
    } catch (error2) {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error2 instanceof Error ? error2.message : String(error2)
        }
      });
    }
  })().finally(() => {
    pendingRequests -= 1;
    maybeShutdown();
  });
});
var shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  rl.close();
  maybeShutdown();
};
rl.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);
