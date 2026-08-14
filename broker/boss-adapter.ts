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
  parseWorkerIdentityV2,
  type BossAuthorizationContext,
  type BossControlEnvelope,
  type BossControlKind,
  type BossControlType,
  type BossPolicyAction,
  type BossPolicyPrincipal,
  type BrokerCapabilityAdvertisement,
  type FeatureAwareAuthorizationDecision,
  type FeatureAwarePolicyState,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  ContractValidationError,
  assertExactKeys,
  assertRecord,
  canonicalJson,
} from "@dataforxyz/agent-intercom-core/canonical";
import type { PolicyAction } from "@dataforxyz/agent-intercom-core/policy";
import { types as nodeUtilTypes } from "node:util";
import type {
  BrokerMessage,
  BossParticipantBindingMetadata,
  BossParticipantRegistrationMetadata,
  ClientMessage,
  SessionInfo,
} from "../types.ts";

export const BOSS_ADVERTISEMENT_PREDICATES = [
  "protectedProvider",
  "brokerIdentity",
  "credentialRegistry",
  "authorityTransitions",
  "participantHealth",
] as const;

export type BossAdvertisementPredicate = (typeof BOSS_ADVERTISEMENT_PREDICATES)[number];
export type BossAdvertisementReadiness = Readonly<Record<BossAdvertisementPredicate, boolean>>;

export const DORMANT_BOSS_ADVERTISEMENT_READINESS: BossAdvertisementReadiness = Object.freeze({
  protectedProvider: false,
  brokerIdentity: false,
  credentialRegistry: false,
  authorityTransitions: false,
  participantHealth: false,
});

const ORDINARY_SESSION_REGISTRATION_KEYS = [
  "cwd",
  "model",
  "pid",
  "startedAt",
  "lastActivity",
] as const;
const OPTIONAL_SESSION_REGISTRATION_KEYS = ["name", "status", "runtimeInstanceId"] as const;

/**
 * Core's canonical parsers reject exotic descriptors, but a Proxy can mimic a
 * plain record and Array iteration skips holes. Reject both before any Boss
 * value crosses the adapter trust boundary.
 */
export function assertBossCanonicalData(value: unknown, path = "$", seen = new WeakSet<object>()): void {
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
    const expectedKeys = new Set<PropertyKey>(["length"]);
    for (let index = 0; index < value.length; index += 1) expectedKeys.add(String(index));
    if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key))) {
      throw new ContractValidationError(path, "must be a dense array without symbols or extra properties");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new ContractValidationError(`${path}[${index}]`, "sparse array holes are not supported");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
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
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new ContractValidationError(`${path}.${key}`, "must be an own enumerable data property");
    }
    assertBossCanonicalData(descriptor.value, `${path}.${key}`, seen);
  }
}

function parseBossAdvertisementReadiness(value: unknown): BossAdvertisementReadiness {
  assertBossCanonicalData(value, "$.readiness");
  assertRecord(value);
  assertExactKeys(value, BOSS_ADVERTISEMENT_PREDICATES);
  const parsed = {} as Record<BossAdvertisementPredicate, boolean>;
  for (const predicate of BOSS_ADVERTISEMENT_PREDICATES) {
    const enabled = ownDataValue(value, predicate);
    if (typeof enabled !== "boolean") {
      throw new ContractValidationError(`$.readiness.${predicate}`, "must be a boolean");
    }
    parsed[predicate] = enabled;
  }
  return parsed;
}

export function missingBossAdvertisementPredicates(
  readiness: BossAdvertisementReadiness = DORMANT_BOSS_ADVERTISEMENT_READINESS,
): BossAdvertisementPredicate[] {
  const parsed = parseBossAdvertisementReadiness(readiness);
  return BOSS_ADVERTISEMENT_PREDICATES.filter((predicate) => parsed[predicate] !== true);
}

/**
 * The Boss feature is intentionally absent until every lockstep service
 * predicate exists. Merely importing Core contracts can never advertise it.
 */
export function bossCapabilityAdvertisement(
  readiness: BossAdvertisementReadiness = DORMANT_BOSS_ADVERTISEMENT_READINESS,
): BrokerCapabilityAdvertisement | undefined {
  if (missingBossAdvertisementPredicates(readiness).length > 0) return undefined;
  const features = [{
    version: BROKER_FEATURE_ATTESTATION_VERSION,
    feature: BOSS_RUN_FEATURE,
    featureVersion: BOSS_RUN_FEATURE_VERSION,
    semanticsHash: BOSS_RUN_FEATURE_SEMANTICS_HASH,
    controlEnvelopeVersion: BOSS_CONTROL_ENVELOPE_VERSION,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
  }];
  return parseBrokerCapabilityAdvertisement({
    baseProtocolVersion: INTERCOM_BASE_PROTOCOL_VERSION,
    features,
    protocolFeatureContractHash: BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
    featureSetHash: brokerFeatureSetHash(features),
    controlEnvelopeVersion: BOSS_CONTROL_ENVELOPE_VERSION,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
  });
}

function optionalOwnDataValue(value: unknown, key: string): unknown {
  assertRecord(value);
  const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new ContractValidationError(`$.${key}`, "must be an own enumerable data property");
  }
  return descriptor.value;
}

function ownDataValue(value: unknown, key: string): unknown {
  const result = optionalOwnDataValue(value, key);
  if (result === undefined) throw new ContractValidationError(`$.${key}`, "is required");
  return result;
}

export function parseBossParticipantRegistrationMetadata(
  value: unknown,
): BossParticipantRegistrationMetadata {
  assertBossCanonicalData(value);
  assertRecord(value);
  assertExactKeys(value, ["featureContract", "credential"]);
  const featureContract = parseBossRunFeatureContract(ownDataValue(value, "featureContract"));
  if (
    featureContract.baseProtocolVersion !== INTERCOM_BASE_PROTOCOL_VERSION
    || canonicalJson(featureContract) !== canonicalJson(BOSS_RUN_FEATURE_CONTRACT)
  ) {
    throw new ContractValidationError("$.featureContract", "must exactly negotiate boss-run-v1 over base protocol v3");
  }
  const credential = parseBossParticipantCredentialEnvelope(ownDataValue(value, "credential"));
  if (credential.namespace !== featureContract.feature) {
    throw new ContractValidationError("$.credential.namespace", "must match the negotiated feature namespace");
  }
  return { featureContract, credential };
}

export function exactRegistrationKind(
  session: { boss?: unknown },
  value: unknown,
): "ordinary" | "boss" {
  assertBossCanonicalData(session, "$.session");
  assertRecord(session);
  const boss = optionalOwnDataValue(session, "boss");
  if (boss === undefined) {
    if (value === undefined) return "ordinary";
    throw new ContractValidationError("$.registrationKind", "must be absent when Boss metadata is absent");
  }
  if (value !== "boss") {
    throw new ContractValidationError("$.registrationKind", "must be boss when Boss metadata is present");
  }
  return "boss";
}

/**
 * Validate the complete client registration discriminant before the broker
 * projects any fields. Ordinary frames deliberately retain the pre-Boss wire
 * shape: they have no registrationKind and no Boss capability/authority keys.
 */
export function parseExactRegistrationFrame(value: unknown): Extract<ClientMessage, { type: "register" }> {
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
  return value as Extract<ClientMessage, { type: "register" }>;
}

/** Validate the exact broker response shape for the registration requested. */
export function parseExactRegisteredFrame(
  value: unknown,
  expected: "ordinary-local" | "ordinary-remote" | "boss",
): Extract<BrokerMessage, { type: "registered" }> {
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
      participantHealth: true,
    })!;
    const bossFeature = advertisement.features.find((feature) => feature.feature === BOSS_RUN_FEATURE);
    if (
      bossFeature === undefined
      || canonicalJson(bossFeature) !== canonicalJson(expectedAdvertisement.features[0])
      || advertisement.baseProtocolVersion !== expectedAdvertisement.baseProtocolVersion
      || advertisement.protocolFeatureContractHash !== expectedAdvertisement.protocolFeatureContractHash
      || advertisement.controlEnvelopeVersion !== expectedAdvertisement.controlEnvelopeVersion
      || advertisement.capabilityDigest !== expectedAdvertisement.capabilityDigest
    ) throw new ContractValidationError("$.registered.capabilities", "must exactly echo the requested boss-run-v1 contract");
    parseBossParticipantBindingMetadata(ownDataValue(value, "boss"), sessionId);
  } else if (expected === "ordinary-remote") {
    assertExactKeys(value, ["type", "sessionId", "protocol", "version", "remoteAccess", "access"]);
  } else {
    assertExactKeys(value, ["type", "sessionId", "protocol", "version"]);
  }
  if (ownDataValue(value, "type") !== "registered") {
    throw new ContractValidationError("$.registered.type", "must be registered");
  }
  return value as Extract<BrokerMessage, { type: "registered" }>;
}

export function parseBossParticipantBindingMetadata(
  value: unknown,
  expectedSessionId?: string,
): BossParticipantBindingMetadata {
  assertBossCanonicalData(value);
  assertRecord(value);
  assertExactKeys(
    value,
    ["featureContract", "binding", "brokerIdentityVerified"],
    ["assignedParticipantIds", "requestingPrincipalId", "workerIdentity", "participantState"],
  );
  const featureContract = parseBossRunFeatureContract(ownDataValue(value, "featureContract"));
  if (
    featureContract.baseProtocolVersion !== INTERCOM_BASE_PROTOCOL_VERSION
    || canonicalJson(featureContract) !== canonicalJson(BOSS_RUN_FEATURE_CONTRACT)
  ) {
    throw new ContractValidationError("$.featureContract", "must exactly bind boss-run-v1 over base protocol v3");
  }
  const binding = parseBossParticipantBinding(ownDataValue(value, "binding"));
  if (ownDataValue(value, "brokerIdentityVerified") !== true) {
    throw new ContractValidationError("$.brokerIdentityVerified", "must be true for a broker-owned Boss binding");
  }
  if (expectedSessionId !== undefined && binding.sessionId !== expectedSessionId) {
    throw new ContractValidationError("$.binding.sessionId", "must match the registered intercom session");
  }
  const rawAssignedParticipantIds = optionalOwnDataValue(value, "assignedParticipantIds");
  let assignedParticipantIds: string[] | undefined;
  if (rawAssignedParticipantIds !== undefined) {
    if (
      binding.role !== "manager"
      || !Array.isArray(rawAssignedParticipantIds)
      || rawAssignedParticipantIds.some((entry) => typeof entry !== "string" || entry.length === 0)
      || new Set(rawAssignedParticipantIds).size !== rawAssignedParticipantIds.length
    ) {
      throw new ContractValidationError("$.assignedParticipantIds", "must be a unique participant list present only for a Manager");
    }
    assignedParticipantIds = rawAssignedParticipantIds as string[];
  }
  if (binding.role === "manager" && assignedParticipantIds === undefined) {
    throw new ContractValidationError("$.assignedParticipantIds", "is required for a Manager policy binding");
  }
  const rawRequestingPrincipalId = optionalOwnDataValue(value, "requestingPrincipalId");
  if ((binding.role === "council") !== (typeof rawRequestingPrincipalId === "string" && rawRequestingPrincipalId.length > 0)) {
    throw new ContractValidationError("$.requestingPrincipalId", "is required exactly for a Council policy binding");
  }
  const requestingPrincipalId = typeof rawRequestingPrincipalId === "string" ? rawRequestingPrincipalId : undefined;
  const rawWorkerIdentity = optionalOwnDataValue(value, "workerIdentity");
  const rawParticipantState = optionalOwnDataValue(value, "participantState");
  if ((rawWorkerIdentity === undefined) !== (rawParticipantState === undefined)) {
    throw new ContractValidationError("$.workerIdentity", "workerIdentity and participantState must be supplied together");
  }
  const workerIdentity = rawWorkerIdentity === undefined ? undefined : parseWorkerIdentityV2(rawWorkerIdentity);
  const participantState = rawParticipantState === undefined
    ? undefined
    : parseParticipantState(rawParticipantState, "$.participantState");
  if (
    workerIdentity !== undefined
    && (
      !("bossRunId" in workerIdentity)
      || workerIdentity.bossRunId !== binding.bossRunId
      || workerIdentity.participantId !== binding.participantId
      || workerIdentity.bindingEpoch !== binding.bindingEpoch
    )
  ) throw new ContractValidationError("$.workerIdentity", "must match the broker-owned participant binding");
  return {
    featureContract,
    binding,
    brokerIdentityVerified: true,
    ...(assignedParticipantIds === undefined ? {} : { assignedParticipantIds: [...assignedParticipantIds] }),
    ...(requestingPrincipalId === undefined ? {} : { requestingPrincipalId }),
    ...(workerIdentity === undefined ? {} : { workerIdentity, participantState: participantState! }),
  };
}

function bossPrincipal(session: SessionInfo, metadata: BossParticipantBindingMetadata): BossPolicyPrincipal {
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
    ...(binding.assignedManagerParticipantId === undefined
      ? {}
      : { assignedManagerParticipantId: binding.assignedManagerParticipantId }),
    ...(metadata.assignedParticipantIds === undefined
      ? {}
      : { assignedParticipantIds: metadata.assignedParticipantIds }),
    ...(metadata.requestingPrincipalId === undefined
      ? {}
      : { requestingPrincipalId: metadata.requestingPrincipalId }),
  };
}

export function featurePolicyStateForSessions(sessions: Iterable<SessionInfo>): FeatureAwarePolicyState {
  const legacy: FeatureAwarePolicyState["legacy"] = { principals: {} };
  const boss: FeatureAwarePolicyState["boss"] = { principals: {} };
  const registrations: FeatureAwarePolicyState["registrations"] = {};
  for (const session of sessions) {
    if (session.boss !== undefined) {
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
        brokerIdentityVerified: metadata.brokerIdentityVerified,
      };
      continue;
    }
    const principal = session.origin === "remote"
      ? (() => {
          if (!session.parentSessionId || !session.rootSessionId || !session.generation) {
            throw new Error(`Remote session ${session.id} is missing broker-owned policy metadata`);
          }
          return {
            id: session.id,
            kind: "remote" as const,
            state: "active" as const,
            generation: session.generation,
            policy: "remote-tree" as const,
            parentSessionId: session.parentSessionId,
            rootSessionId: session.rootSessionId,
          };
        })()
      : {
          id: session.id,
          kind: "local" as const,
          state: "active" as const,
          generation: 1,
          policy: "local-public" as const,
          rootSessionId: session.id,
        };
    legacy.principals[session.id] = principal;
    registrations[session.id] = { principalId: session.id, principalClass: "ordinary", state: "active" };
  }
  return { legacy, boss, registrations };
}

export function authorizeBossAwareSessionAction(
  sessions: Iterable<SessionInfo>,
  actorId: string,
  action: PolicyAction | BossPolicyAction,
  targetId: string,
  bossContext?: BossAuthorizationContext,
): FeatureAwareAuthorizationDecision {
  const values = Array.from(sessions);
  const state = featurePolicyStateForSessions(values);
  const actor = state.registrations[actorId];
  const target = state.registrations[targetId];
  return authorizeFeatureAware(state, {
    actorId,
    action,
    targetId,
    ...(actor?.principalClass === "ordinary" && target?.principalClass === "ordinary"
      ? {
          legacyContext: {
            actorGeneration: state.legacy.principals[actorId]?.generation,
            targetGeneration: state.legacy.principals[targetId]?.generation,
          },
        }
      : bossContext === undefined ? {} : { bossContext }),
  });
}

const BOSS_CONTROL_KIND_BY_TYPE: Readonly<Record<BossControlType, BossControlKind>> = {
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
  "boss.decision.required": "decision",
};

export function bossControlKind(envelopeValue: unknown): {
  envelope: BossControlEnvelope;
  controlKind: BossControlKind;
} {
  assertBossCanonicalData(envelopeValue);
  const envelope = parseBossControlEnvelope(envelopeValue);
  return { envelope, controlKind: BOSS_CONTROL_KIND_BY_TYPE[envelope.type] };
}

/** The legacy broker has no authoritative Boss causation ledger. */
export function hasAuthoritativeBossControlCorrelation(): false {
  return false;
}

export function exactBossSessionTarget<T extends { info: { id: string } }>(
  sessions: ReadonlyMap<string, T>,
  requestedSessionId: string,
): T | undefined {
  const target = sessions.get(requestedSessionId);
  return target?.info.id === requestedSessionId ? target : undefined;
}

export function assertBossControlSender(
  session: SessionInfo,
  envelopeValue: unknown,
): BossControlEnvelope {
  const { envelope } = bossControlKind(envelopeValue);
  if (session.boss === undefined) {
    throw new ContractValidationError("$.session", "ordinary sessions cannot originate Boss control envelopes");
  }
  const { binding } = parseBossParticipantBindingMetadata(session.boss, session.id);
  if (
    binding.state !== "active"
    || envelope.bossRunId !== binding.bossRunId
    || envelope.participantId !== binding.participantId
    || envelope.bindingEpoch !== binding.bindingEpoch
  ) {
    throw new ContractValidationError("$.envelope", "does not match the active broker-owned participant binding");
  }
  return envelope;
}
