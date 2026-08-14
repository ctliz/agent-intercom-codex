import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_RUN_FEATURE_CONTRACT,
  BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
  BROKER_FEATURE_ATTESTATION_VERSION,
  BROKER_PROTECTED_PROVIDER_ROOT,
  INTERCOM_BASE_PROTOCOL_VERSION,
} from "@ctliz/agent-intercom-core/boss";
import {
  bossCapabilityAdvertisement,
  DORMANT_BOSS_ADVERTISEMENT_READINESS,
} from "../broker/boss-adapter.ts";
import {
  BOSS_PROTECTED_SERVICE_UNAVAILABLE,
  CODEX_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
  CODEX_BOSS_PROTECTED_PROVIDER_ID,
  CODEX_BOSS_PROTECTED_PROVIDER_PACKAGE,
  CodexBossProtectedServiceError,
  ensureCodexBossProtectedService,
  parseCodexBossProtectedProviderArtifactCandidate,
} from "./protected-service.ts";
import {
  CODEX_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
  startCodexBossProtectedProvider,
} from "./entry.ts";

const repositoryRoot = new URL("..", import.meta.url);
const generatedProviderUrl = new URL("provider/provider.mjs", repositoryRoot);
const buildScriptUrl = new URL("scripts/build-protected-provider.mjs", repositoryRoot);

function generatedProviderBytes(): Buffer {
  return readFileSync(generatedProviderUrl);
}

function providerCandidate(): Record<string | symbol, unknown> {
  return {
    adapterId: CODEX_BOSS_PROTECTED_PROVIDER_ID,
    providerPackage: CODEX_BOSS_PROTECTED_PROVIDER_PACKAGE,
    providerVersion: "0.10.0",
    providerDigest: createHash("sha256").update(generatedProviderBytes()).digest("hex"),
    artifactPath: CODEX_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
    artifactOwnerUid: 0,
    artifactOwnerGid: 0,
    artifactMode: "0555",
  };
}

function expectCandidateInvalid(value: unknown): CodexBossProtectedServiceError {
  let observed: unknown;
  try {
    parseCodexBossProtectedProviderArtifactCandidate(value);
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof CodexBossProtectedServiceError);
  assert.equal(observed.code, "INVALID_CODEX_PROTECTED_PROVIDER_CANDIDATE");
  return observed;
}

test("normalizes only the canonical unsigned non-authoritative Codex provider candidate", () => {
  assert.equal(
    CODEX_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
    `${BROKER_PROTECTED_PROVIDER_ROOT}codex/provider.mjs`,
  );
  const candidate = providerCandidate();
  const snapshot = structuredClone(candidate);
  const parsed = parseCodexBossProtectedProviderArtifactCandidate(candidate);

  assert.deepEqual(candidate, snapshot);
  assert.deepEqual(parsed, candidate);
  assert.deepEqual(Reflect.ownKeys(parsed), [
    "adapterId", "providerPackage", "providerVersion", "providerDigest",
    "artifactPath", "artifactOwnerUid", "artifactOwnerGid", "artifactMode",
  ]);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(Object.hasOwn(parsed, "signature"), false);
  assert.equal(Object.hasOwn(parsed, "attestationKeyId"), false);
});

test("rejects substitution, writable artifacts, noncanonical versions, and non-lowercase digests", () => {
  const mutations: Array<[string, unknown]> = [
    ["adapterId", "pi"],
    ["providerPackage", "@attacker/agent-intercom-codex"],
    ["providerVersion", "01.0.0"],
    ["providerVersion", "1.0.0-01"],
    ["providerVersion", "latest"],
    ...["\n", "\r", "\u2028", "\u2029"].map((terminator) => ["providerVersion", `1.2.3${terminator}`] as [string, unknown]),
    ["providerDigest", "A".repeat(64)],
    ["providerDigest", "a".repeat(63)],
    ...["\n", "\r", "\u2028", "\u2029"].map((terminator) => ["providerDigest", `${"a".repeat(64)}${terminator}`] as [string, unknown]),
    ["artifactPath", "/usr/lib/agent-intercom/providers/codex/../evil/provider.mjs"],
    ["artifactPath", "/tmp/codex/provider.mjs"],
    ["artifactOwnerUid", 1000],
    ["artifactOwnerGid", 1000],
    ["artifactMode", "0755"],
  ];

  for (const [field, replacement] of mutations) {
    const candidate = providerCandidate();
    candidate[field] = replacement;
    expectCandidateInvalid(candidate);
  }
});

test("never accepts caller-supplied attestation, trust, identity, credential, or installation facts", () => {
  for (const forbidden of [
    "version",
    "userWritable",
    "authoritative",
    "signature",
    "attestationKeyId",
    "trustedReleaseKeys",
    "ownerUid",
    "brokerServiceUid",
    "controllerServiceUid",
    "identityKeyId",
    "brokerGeneration",
    "serviceCapability",
    "credential",
    "installed",
  ]) {
    const candidate = providerCandidate();
    candidate[forbidden] = forbidden === "installed" ? true : "attacker-controlled";
    expectCandidateInvalid(candidate);
  }
});

test("rejects proxies, inheritance, accessors, symbols, and non-data fields without getter execution", () => {
  let invoked = false;
  const proxied = new Proxy(providerCandidate(), {
    get() { invoked = true; throw new Error("must not read proxy"); },
    getOwnPropertyDescriptor() { invoked = true; throw new Error("must not inspect proxy"); },
    getPrototypeOf() { invoked = true; throw new Error("must not inspect proxy"); },
    ownKeys() { invoked = true; throw new Error("must not enumerate proxy"); },
  });
  expectCandidateInvalid(proxied);
  assert.equal(invoked, false);

  expectCandidateInvalid(Object.create(providerCandidate()));

  const accessor = providerCandidate();
  Object.defineProperty(accessor, "providerVersion", {
    enumerable: true,
    get() { invoked = true; throw new Error("must not invoke getter"); },
  });
  expectCandidateInvalid(accessor);
  assert.equal(invoked, false);

  const symbol = providerCandidate();
  symbol[Symbol("authority")] = true;
  expectCandidateInvalid(symbol);

  const hidden = providerCandidate();
  Object.defineProperty(hidden, "providerDigest", {
    enumerable: false,
    value: hidden.providerDigest,
  });
  expectCandidateInvalid(hidden);
});

test("production ensure reports unavailability before hostile request inspection", () => {
  let invoked = false;
  const request = new Proxy({}, {
    get() { invoked = true; throw new Error("must not inspect request"); },
    getOwnPropertyDescriptor() { invoked = true; throw new Error("must not inspect request"); },
    getPrototypeOf() { invoked = true; throw new Error("must not inspect request"); },
    ownKeys() { invoked = true; throw new Error("must not enumerate request"); },
  });

  assert.throws(
    () => ensureCodexBossProtectedService(request),
    (error: unknown) => error instanceof CodexBossProtectedServiceError
      && error.code === BOSS_PROTECTED_SERVICE_UNAVAILABLE
      && error.path === "$provisioner",
  );
  assert.equal(invoked, false);
});

test("generated provider is deterministic and contains no workspace or installation path", async () => {
  const { buildProtectedProvider } = await import(buildScriptUrl.href) as {
    buildProtectedProvider(): string;
  };
  const committed = generatedProviderBytes();
  const firstOutput = buildProtectedProvider();
  const first = generatedProviderBytes();
  const secondOutput = buildProtectedProvider();
  const second = generatedProviderBytes();

  assert.deepEqual(first, committed);
  assert.deepEqual(second, first);
  assert.equal(firstOutput, first.toString("utf8"));
  assert.equal(secondOutput, firstOutput);
  const source = second.toString("utf8");
  assert.doesNotMatch(source, /\/home\/|\/Users\/|[A-Z]:\\/);
  assert.doesNotMatch(source, /\/usr\/lib\/agent-intercom|\/run\/agent-intercom|\/var\/lib\/agent-intercom/);
});

test("source and generated provider expose the same immutable dormant build identity", async () => {
  const generated = await import(generatedProviderUrl.href) as typeof import("./entry.ts");
  assert.deepEqual(Object.keys(generated).sort(), [
    "CODEX_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY",
    "startCodexBossProtectedProvider",
  ]);
  assert.deepEqual(
    generated.CODEX_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
    CODEX_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
  );

  for (const identity of [
    CODEX_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
    generated.CODEX_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
  ]) {
    assert.ok(Object.isFrozen(identity));
    assert.ok(Object.isFrozen(identity.supportedBaseProtocolVersions));
    assert.ok(Object.isFrozen(identity.supportedFeatures));
    assert.ok(Object.isFrozen(identity.supportedFeatures[0]));
    assert.equal(identity.contractVersion, "codex.boss-protected-provider.v1");
    assert.equal(identity.adapterId, "codex");
    assert.equal(identity.providerPackage, "@ctliz/agent-intercom-codex");
    assert.equal(identity.authoritative, false);
    assert.equal(identity.providerStartAvailable, false);
    assert.equal(identity.bossAdvertisementEnabled, false);
    assert.deepEqual(identity.supportedBaseProtocolVersions, [INTERCOM_BASE_PROTOCOL_VERSION]);
    assert.deepEqual(identity.supportedFeatures, [{
      version: BROKER_FEATURE_ATTESTATION_VERSION,
      feature: BOSS_RUN_FEATURE_CONTRACT.feature,
      featureVersion: BOSS_RUN_FEATURE_CONTRACT.version,
      semanticsHash: BOSS_RUN_FEATURE_CONTRACT.semanticsHash,
      controlEnvelopeVersion: BOSS_RUN_FEATURE_CONTRACT.controlEnvelopeVersion,
      capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
    }]);
    assert.equal(identity.protocolFeatureContractHash, BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH);
  }
});

test("provider has zero runtime imports/integration and start fails before request inspection", async () => {
  const source = readFileSync(new URL("provider/entry.ts", repositoryRoot), "utf8");
  const generatedSource = generatedProviderBytes().toString("utf8");
  for (const value of [source, generatedSource]) {
    assert.doesNotMatch(value, /^\s*import\s/m);
    assert.doesNotMatch(value, /\brequire\s*\(/);
    assert.doesNotMatch(value, /\bimport\s*\(/);
    assert.doesNotMatch(value, /node:(?:fs|child_process|net|process|os)/);
    assert.doesNotMatch(value, /systemctl|\.listen\(|\.connect\(|\.kill\(|\.spawn\(|broker\/(?:broker|spawn|paths|ownership)/);
  }

  const generated = await import(generatedProviderUrl.href) as typeof import("./entry.ts");
  for (const start of [startCodexBossProtectedProvider, generated.startCodexBossProtectedProvider]) {
    let invoked = false;
    const request = Object.defineProperty({}, "ownerUid", {
      enumerable: true,
      get() { invoked = true; throw new Error("must not inspect start request"); },
    });
    assert.throws(
      () => start(request),
      (error: unknown) => typeof error === "object"
        && error !== null
        && (error as { code?: unknown }).code === "BOSS_PROTECTED_PROVIDER_START_UNAVAILABLE",
    );
    assert.equal(invoked, false);
  }
});

test("protected-provider packaging does not activate or advertise Boss", () => {
  assert.equal(bossCapabilityAdvertisement(), undefined);
  assert.deepEqual(DORMANT_BOSS_ADVERTISEMENT_READINESS, {
    protectedProvider: false,
    brokerIdentity: false,
    credentialRegistry: false,
    authorityTransitions: false,
    participantHealth: false,
  });
});
