import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash } from "@ctliz/agent-intercom-core/canonical";
import { parseBossControlEnvelope, type BossControlEnvelope } from "@ctliz/agent-intercom-core/boss";
import { assertBossCanonicalData } from "./broker/boss-adapter.ts";
import { ensureIntercomRuntimeDir, getIntercomDirPath, INTERCOM_DIR_MODE, restrictIntercomRuntimeFile } from "./broker/paths.ts";
import { writeDurableJson } from "./durable-json.ts";

const BOSS_CONTROL_OUTBOX_VERSION = 2;
const MAX_BOSS_CONTROL_OUTBOX_ENTRIES = 256;

export interface StoredBossControl {
  to: string;
  envelope: BossControlEnvelope;
  scope: string;
  fingerprint: string;
  queuedAt: number;
  state: "queued" | "accepted";
  deliveryId?: string;
}

interface BossControlOutboxState {
  version: typeof BOSS_CONTROL_OUTBOX_VERSION;
  entries: StoredBossControl[];
}

function scope(envelope: BossControlEnvelope): string {
  return canonicalHash("agent-intercom-codex/boss-control/outbox-scope/v1", {
    bossRunId: envelope.bossRunId,
    participantId: envelope.participantId,
    bindingEpoch: Number(envelope.bindingEpoch),
    idempotencyKey: envelope.idempotencyKey,
  });
}

function fingerprint(to: string, envelope: BossControlEnvelope): string {
  const { messageId: _transportMessageId, ...stableEnvelope } = envelope;
  return canonicalHash("agent-intercom-codex/boss-control/outbox-request/v1", { to, envelope: stableEnvelope });
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const permitted = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => typeof key === "string" && permitted.has(key));
}

function parseEntry(value: unknown): StoredBossControl {
  assertBossCanonicalData(value, "$.bossControlOutbox.entries[]");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Boss outbox entry");
  const entry = value as Record<string, unknown>;
  if (!exactKeys(entry, ["to", "envelope", "scope", "fingerprint", "queuedAt", "state"], ["deliveryId"])) {
    throw new Error("Invalid Boss outbox entry fields");
  }
  if (
    typeof entry.to !== "string"
    || entry.to.length === 0
    || typeof entry.scope !== "string"
    || !/^[a-f0-9]{64}$/.test(entry.scope)
    || typeof entry.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
    || typeof entry.queuedAt !== "number"
    || !Number.isSafeInteger(entry.queuedAt)
    || (entry.state !== "queued" && entry.state !== "accepted")
    || (entry.state === "queued" && Object.hasOwn(entry, "deliveryId"))
    || (entry.state === "accepted" && (!Object.hasOwn(entry, "deliveryId") || typeof entry.deliveryId !== "string" || entry.deliveryId.length === 0))
  ) throw new Error("Invalid Boss outbox entry binding");
  const envelope = parseBossControlEnvelope(entry.envelope);
  if (entry.scope !== scope(envelope) || entry.fingerprint !== fingerprint(entry.to, envelope)) {
    throw new Error("Boss outbox entry canonical binding mismatch");
  }
  return {
    to: entry.to,
    envelope,
    scope: entry.scope,
    fingerprint: entry.fingerprint,
    queuedAt: entry.queuedAt,
    state: entry.state,
    ...(entry.deliveryId === undefined ? {} : { deliveryId: entry.deliveryId as string }),
  };
}

function fileName(sessionId: string): string {
  return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

export class PersistentBossControlOutbox {
  private readonly path: string;
  private state: BossControlOutboxState;

  constructor(sessionId: string, intercomDir: string = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    const directory = join(intercomDir, "boss-control-outbox");
    mkdirSync(directory, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync(directory, INTERCOM_DIR_MODE);
    this.path = join(directory, fileName(sessionId));
    this.state = this.load();
  }

  list(): StoredBossControl[] {
    return structuredClone(this.state.entries);
  }

  find(idempotencyKey: string): StoredBossControl | undefined {
    const entry = this.state.entries.find((candidate) => candidate.envelope.idempotencyKey === idempotencyKey);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  enqueue(to: string, envelopeValue: unknown): "added" | "existing" {
    if (typeof to !== "string" || to.length === 0) throw new Error("Boss target session ID is required");
    assertBossCanonicalData(envelopeValue, "$.envelope");
    const envelope = parseBossControlEnvelope(envelopeValue);
    const candidateScope = scope(envelope);
    const candidateFingerprint = fingerprint(to, envelope);
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
      state: "queued",
    });
    this.persist();
    return "added";
  }

  markAccepted(idempotencyKey: string, messageId: string, deliveryId: string): "accepted" | "already-accepted" {
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

  removeCorrelated(idempotencyKey: string, messageId: string, deliveryId?: string): void {
    const index = this.state.entries.findIndex((candidate) => candidate.envelope.idempotencyKey === idempotencyKey);
    if (index < 0) throw new Error("Boss terminal result has no durable outbox binding");
    const entry = this.state.entries[index];
    if (entry.envelope.messageId !== messageId) throw new Error("Boss terminal result messageId does not match the durable caller");
    if (deliveryId === undefined) {
      if (entry.state !== "queued") throw new Error("Boss post-acceptance failure omitted the durable deliveryId");
    } else if (entry.state !== "accepted" || entry.deliveryId !== deliveryId) {
      throw new Error("Boss terminal result arrived before the matching durable acknowledgement");
    }
    this.state.entries.splice(index, 1);
    this.persist();
  }

  private load(): BossControlOutboxState {
    if (!existsSync(this.path)) return { version: BOSS_CONTROL_OUTBOX_VERSION, entries: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      assertBossCanonicalData(parsed, "$.bossControlOutbox");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed as Record<string, unknown>;
      if (!exactKeys(state, ["version", "entries"]) || state.version !== BOSS_CONTROL_OUTBOX_VERSION || !Array.isArray(state.entries)) {
        throw new Error("invalid Boss outbox state");
      }
      return { version: BOSS_CONTROL_OUTBOX_VERSION, entries: state.entries.map(parseEntry) };
    } catch (error) {
      const corruptPath = `${this.path}.corrupt-${Date.now()}`;
      renameSync(this.path, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      throw new Error(`Boss control outbox was corrupt and quarantined at ${corruptPath}`, { cause: error });
    }
  }

  private persist(): void {
    writeDurableJson(this.path, this.state);
  }
}
