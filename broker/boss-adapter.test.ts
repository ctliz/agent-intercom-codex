import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_PARTICIPANT_CREDENTIAL_VERSION,
  BOSS_RUN_FEATURE_CONTRACT,
  INTERCOM_BASE_PROTOCOL_VERSION,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  bossCapabilityAdvertisement,
  hasAuthoritativeBossControlCorrelation,
  exactRegistrationKind,
  exactBossSessionTarget,
  missingBossAdvertisementPredicates,
  parseExactRegisteredFrame,
  parseExactRegistrationFrame,
  assertBossCanonicalData,
  parseBossParticipantBindingMetadata,
  parseBossParticipantRegistrationMetadata,
} from "./boss-adapter.ts";

test("Boss advertisement remains dormant until every lockstep predicate is ready", () => {
  assert.equal(bossCapabilityAdvertisement(), undefined);
  assert.deepEqual(missingBossAdvertisementPredicates(), [
    "protectedProvider",
    "brokerIdentity",
    "credentialRegistry",
    "authorityTransitions",
    "participantHealth",
  ]);
  const advertisement = bossCapabilityAdvertisement({
    protectedProvider: true,
    brokerIdentity: true,
    credentialRegistry: true,
    authorityTransitions: true,
    participantHealth: true,
  });
  assert.equal(advertisement?.baseProtocolVersion, INTERCOM_BASE_PROTOCOL_VERSION);
  assert.equal(advertisement?.features[0]?.feature, "boss-run-v1");
});

test("Boss readiness is an exact proxy-first descriptor schema", () => {
  assert.throws(() => bossCapabilityAdvertisement({} as never));
  assert.throws(() => bossCapabilityAdvertisement({
    protectedProvider: true,
    brokerIdentity: true,
    credentialRegistry: true,
    authorityTransitions: true,
    participantHealth: true,
    extra: true,
  } as never));
  for (const mutate of [
    (value: Record<string, unknown>) => Object.defineProperty(value, "protectedProvider", { value: true, enumerable: false }),
    (value: Record<string, unknown>) => Object.defineProperty(value, "protectedProvider", { get: () => true, enumerable: true }),
    (value: Record<string, unknown>) => Object.defineProperty(value, Symbol("hidden"), { value: true, enumerable: true }),
    (value: Record<string, unknown>) => Object.setPrototypeOf(value, { inherited: true }),
  ]) {
    const value: Record<string, unknown> = {
      protectedProvider: true,
      brokerIdentity: true,
      credentialRegistry: true,
      authorityTransitions: true,
      participantHealth: true,
    };
    mutate(value);
    assert.throws(() => bossCapabilityAdvertisement(value as never));
  }
  let trapCount = 0;
  const proxy = new Proxy({}, {
    get() { trapCount += 1; throw new Error("trap"); },
    ownKeys() { trapCount += 1; throw new Error("trap"); },
    getOwnPropertyDescriptor() { trapCount += 1; throw new Error("trap"); },
    getPrototypeOf() { trapCount += 1; throw new Error("trap"); },
  });
  assert.throws(() => bossCapabilityAdvertisement(proxy as never), /proxies are not supported/);
  assert.equal(trapCount, 0);
});

test("canonical arrays reject sparse, inherited/custom, accessor, symbol, extra, duplicate, and coercible entries", () => {
  const hostile: unknown[] = [];
  hostile.push(new Array(1));
  const customPrototype = ["worker-1"];
  Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
  hostile.push(customPrototype);
  const accessor = ["worker-1"];
  Object.defineProperty(accessor, "0", { get: () => "worker-1", enumerable: true, configurable: true });
  hostile.push(accessor);
  const symbol = ["worker-1"];
  Object.defineProperty(symbol, Symbol("hidden"), { value: true });
  hostile.push(symbol);
  const extra = ["worker-1"] as unknown[] & { extra?: boolean };
  extra.extra = true;
  hostile.push(extra);
  for (const value of hostile) assert.throws(() => assertBossCanonicalData(value));
});

test("participant registration negotiates the exact Core feature and credential binding", () => {
  const registration = parseBossParticipantRegistrationMetadata({
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    credential: {
      version: BOSS_PARTICIPANT_CREDENTIAL_VERSION,
      namespace: "boss-run-v1",
      credentialKind: "enrollment",
      credentialId: "credential-1",
      credential: "secret-token",
      bossRunId: "run-1",
      participantId: "worker-1",
      role: "worker",
      communicationProfile: "worker",
      bindingEpoch: 1,
      issuedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T01:00:00.000Z",
      nonce: "nonce-1",
    },
  });
  assert.equal(registration.featureContract.baseProtocolVersion, 4);
  assert.equal(registration.credential.participantId, "worker-1");
});

test("binding metadata is broker-owned and session-bound", () => {
  const metadata = {
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    binding: {
      version: BOSS_PARTICIPANT_BINDING_VERSION,
      bossRunId: "run-1",
      participantId: "manager-1",
      role: "manager",
      communicationProfile: "manager",
      bindingEpoch: 1,
      sessionId: "session-manager",
      brokerGeneration: 1,
      brokerBootInstance: "boot-1",
      state: "active",
      authorityTransitionId: "transition-1",
    },
    brokerIdentityVerified: true,
    assignedParticipantIds: ["worker-1"],
  };
  assert.equal(parseBossParticipantBindingMetadata(metadata, "session-manager").binding.role, "manager");
  assert.throws(() => parseBossParticipantBindingMetadata(metadata, "session-substitution"), /registered intercom session/);
});

test("Boss metadata rejects proxies and sparse policy arrays", () => {
  const metadata = {
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    binding: {
      version: BOSS_PARTICIPANT_BINDING_VERSION,
      bossRunId: "run-1",
      participantId: "manager-1",
      role: "manager",
      communicationProfile: "manager",
      bindingEpoch: 1,
      sessionId: "session-manager",
      brokerGeneration: 1,
      brokerBootInstance: "boot-1",
      state: "active",
      authorityTransitionId: "transition-1",
    },
    brokerIdentityVerified: true,
    assignedParticipantIds: ["worker-1"],
  };
  assert.throws(
    () => parseBossParticipantBindingMetadata(new Proxy(metadata, {}), "session-manager"),
    /proxies are not supported/,
  );
  const sparse = { ...metadata, assignedParticipantIds: new Array(1) };
  assert.throws(() => parseBossParticipantBindingMetadata(sparse, "session-manager"), /dense array|sparse array holes/);
  assert.throws(() => parseBossParticipantBindingMetadata({ ...metadata, assignedParticipantIds: ["worker-1", "worker-1"] }, "session-manager"), /unique participant list/);
  assert.throws(() => parseBossParticipantBindingMetadata({ ...metadata, assignedParticipantIds: [1] }, "session-manager"), /unique participant list/);
});

test("dormant legacy broker never manufactures Boss correlation evidence", () => {
  assert.equal(hasAuthoritativeBossControlCorrelation(), false);
});

test("Boss registration cannot be folded into an ordinary registration", () => {
  assert.equal(exactRegistrationKind({}, undefined), "ordinary");
  assert.throws(() => exactRegistrationKind({}, "ordinary"), /must be absent/);
  assert.throws(() => exactRegistrationKind({ boss: {} }, "ordinary"), /must be boss/);
  assert.throws(() => exactRegistrationKind({}, "boss"), /must be absent/);
});

test("ordinary and Boss registration frames use exact non-folding discriminants", () => {
  const ordinary = {
    type: "register",
    protocol: "pi-intercom",
    version: 4,
    session: { cwd: "/tmp", model: "gpt", pid: 1, startedAt: 1, lastActivity: 1 },
  };
  assert.equal(parseExactRegistrationFrame(ordinary).type, "register");
  for (const folded of [
    { registrationKind: "ordinary" },
    { capabilities: {} },
    { boss: {} },
    { featureContract: {} },
    { binding: {} },
  ]) assert.throws(() => parseExactRegistrationFrame({ ...ordinary, ...folded }));
  assert.throws(() => parseExactRegistrationFrame({ ...ordinary, session: { ...ordinary.session, boss: {} } }));

  const registered = { type: "registered", sessionId: "session-1", protocol: "pi-intercom", version: 4 };
  assert.equal(parseExactRegisteredFrame(registered, "ordinary-local").type, "registered");
  for (const unsolicited of [
    { registrationKind: "ordinary" },
    { capabilities: {} },
    { boss: {} },
    { access: {} },
  ]) assert.throws(() => parseExactRegisteredFrame({ ...registered, ...unsolicited }, "ordinary-local"));
});

test("requested Boss registered frame requires exact capability echo and broker-owned binding", () => {
  const capabilities = bossCapabilityAdvertisement({
    protectedProvider: true,
    brokerIdentity: true,
    credentialRegistry: true,
    authorityTransitions: true,
    participantHealth: true,
  })!;
  const boss = {
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    binding: {
      version: BOSS_PARTICIPANT_BINDING_VERSION,
      bossRunId: "run-1",
      participantId: "manager-1",
      role: "manager",
      communicationProfile: "manager",
      bindingEpoch: 1,
      sessionId: "session-manager",
      brokerGeneration: 1,
      brokerBootInstance: "boot-1",
      state: "active",
      authorityTransitionId: "transition-1",
    },
    brokerIdentityVerified: true,
    assignedParticipantIds: [],
  };
  const frame = {
    type: "registered",
    registrationKind: "boss",
    sessionId: "session-manager",
    protocol: "pi-intercom",
    version: 4,
    capabilities,
    boss,
  };
  assert.equal(parseExactRegisteredFrame(frame, "boss").type, "registered");
  assert.throws(() => parseExactRegisteredFrame({ ...frame, capabilities: { ...capabilities, features: [] } }, "boss"));
  assert.throws(() => parseExactRegisteredFrame({ ...frame, capabilities: { ...capabilities, baseProtocolVersion: 99 } }, "boss"));
  const { capabilities: _capabilities, ...withoutCapabilities } = frame;
  assert.throws(() => parseExactRegisteredFrame(withoutCapabilities, "boss"));
  const { boss: _boss, ...withoutBinding } = frame;
  assert.throws(() => parseExactRegisteredFrame(withoutBinding, "boss"));
});

test("Boss routing accepts only the exact session ID, never names or prefixes", () => {
  const session = { info: { id: "session-exact" } };
  const sessions = new Map([["session-exact", session]]);
  assert.equal(exactBossSessionTarget(sessions, "session-exact"), session);
  assert.equal(exactBossSessionTarget(sessions, "session"), undefined);
  assert.equal(exactBossSessionTarget(sessions, "friendly-name"), undefined);
});
