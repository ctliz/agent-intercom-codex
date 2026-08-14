import { existsSync, readFileSync, renameSync } from "node:fs";
import { canonicalJson } from "@ctliz/agent-intercom-core/canonical";
import { writeDurableJson } from "../durable-json.ts";
import { assertBossCanonicalData } from "./boss-adapter.ts";
import { restrictIntercomRuntimeFile } from "./paths.ts";
import type { BrokerMessage } from "../types.ts";

const BOSS_CONTROL_LEDGER_VERSION = 3;
const EXPIRING_BOSS_CONTROL_LEDGER_VERSION = 2;
const MAX_BOSS_CONTROL_RESULTS = 2048;
const BOSS_CONTROL_FAILURE_CODES = new Set([
  "INVALID_CONTROL",
  "IDEMPOTENCY_CONFLICT",
  "SESSION_NOT_FOUND",
  "POLICY_DENIED",
  "RECIPIENT_DISCONNECTED",
  "DELIVERY_TIMEOUT",
]);

export type BossControlResult = Extract<BrokerMessage, { type: "boss_control_result" }>;
export type BossControlAck = Extract<BrokerMessage, { type: "boss_control_ack" }>;

interface BossControlLedgerEntryBase {
  scope: string;
  fingerprint: string;
}

interface AcceptedBossControlLedgerEntry extends BossControlLedgerEntryBase {
  state: "accepted";
  deliveryId: string;
}

interface TerminalBossControlLedgerEntry extends BossControlLedgerEntryBase {
  state: "terminal";
  result: BossControlResult;
}

type BossControlLedgerEntry = AcceptedBossControlLedgerEntry | TerminalBossControlLedgerEntry;

interface BossControlLedgerState {
  version: typeof BOSS_CONTROL_LEDGER_VERSION;
  entries: BossControlLedgerEntry[];
}

function exactStringKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Reflect.ownKeys(value);
  const permitted = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => typeof key === "string" && permitted.has(key));
}

export function parseBossControlResult(value: unknown): BossControlResult {
  assertBossCanonicalData(value, "$.bossControlResult");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Boss control result must be an exact plain object");
  }
  const result = value as Record<string, unknown>;
  const base = typeof result.requestId === "string"
    && result.requestId.length > 0
    && result.messageId === result.requestId
    && typeof result.idempotencyKey === "string"
    && result.idempotencyKey.length > 0;
  if (!base || result.type !== "boss_control_result") throw new Error("Invalid Boss control result binding");
  if (
    result.status === "delivered"
    && result.delivered === true
    && typeof result.deliveryId === "string"
    && result.deliveryId.length > 0
    && exactStringKeys(result, ["type", "requestId", "messageId", "idempotencyKey", "status", "delivered", "deliveryId"])
  ) return result as unknown as BossControlResult;
  if (
    result.status === "rejected"
    && result.delivered === false
    && typeof result.code === "string"
    && BOSS_CONTROL_FAILURE_CODES.has(result.code)
    && typeof result.reason === "string"
    && result.reason.length > 0
    && (!Object.hasOwn(result, "deliveryId") || (typeof result.deliveryId === "string" && result.deliveryId.length > 0))
    && exactStringKeys(
      result,
      ["type", "requestId", "messageId", "idempotencyKey", "status", "delivered", "code", "reason"],
      ["deliveryId"],
    )
  ) return result as unknown as BossControlResult;
  throw new Error("Invalid Boss control result discriminant");
}

export function parseBossControlAck(value: unknown): BossControlAck {
  assertBossCanonicalData(value, "$.bossControlAck");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Boss control acknowledgement must be an exact plain object");
  }
  const ack = value as Record<string, unknown>;
  if (
    !exactStringKeys(ack, ["type", "requestId", "messageId", "idempotencyKey", "status", "deliveryId"])
    || ack.type !== "boss_control_ack"
    || typeof ack.requestId !== "string"
    || ack.requestId.length === 0
    || ack.messageId !== ack.requestId
    || typeof ack.idempotencyKey !== "string"
    || ack.idempotencyKey.length === 0
    || ack.status !== "accepted"
    || typeof ack.deliveryId !== "string"
    || ack.deliveryId.length === 0
  ) throw new Error("Invalid Boss control acknowledgement discriminant");
  return ack as unknown as BossControlAck;
}

export function rebindBossControlResult(resultValue: unknown, messageId: string): BossControlResult {
  if (typeof messageId !== "string" || messageId.length === 0) throw new Error("Replay messageId is required");
  const result = parseBossControlResult(resultValue);
  return parseBossControlResult({ ...result, requestId: messageId, messageId });
}

export function bossControlReplayFrames(resultValue: unknown, messageId: string): [BossControlResult] | [BossControlAck, BossControlResult] {
  const result = rebindBossControlResult(resultValue, messageId);
  if (result.deliveryId === undefined) return [result];
  return [{
    type: "boss_control_ack",
    requestId: messageId,
    messageId,
    idempotencyKey: result.idempotencyKey,
    status: "accepted",
    deliveryId: result.deliveryId,
  }, result];
}

/**
 * A caller recovering a durable accepted entry is newly attached to the
 * stable delivery. It must observe that accepted transition before any
 * terminal denial produced while the broker revalidates the target.
 */
export function bossControlAcceptedRecoveryFrames(
  resultValue: unknown,
): [BossControlAck, BossControlResult] {
  const result = parseBossControlResult(resultValue);
  if (result.status !== "rejected" || result.deliveryId === undefined) {
    throw new Error("Accepted Boss recovery requires a delivery-bound rejected result");
  }
  return [{
    type: "boss_control_ack",
    requestId: result.requestId,
    messageId: result.messageId,
    idempotencyKey: result.idempotencyKey,
    status: "accepted",
    deliveryId: result.deliveryId,
  }, result];
}

function parseHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid Boss ledger ${field}`);
  return value;
}

function parseEntry(value: unknown, version: number): BossControlLedgerEntry {
  assertBossCanonicalData(value, "$.entries[]");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Boss ledger entry");
  const entry = value as Record<string, unknown>;
  const legacyExpiry = version === EXPIRING_BOSS_CONTROL_LEDGER_VERSION;
  if (legacyExpiry && (typeof entry.expiresAt !== "number" || !Number.isSafeInteger(entry.expiresAt))) {
    throw new Error("Invalid Boss ledger expiry");
  }
  const base: BossControlLedgerEntryBase = {
    scope: parseHash(entry.scope, "scope"),
    fingerprint: parseHash(entry.fingerprint, "fingerprint"),
  };
  const baseKeys = legacyExpiry
    ? ["scope", "fingerprint", "expiresAt", "state"]
    : ["scope", "fingerprint", "state"];
  if (
    entry.state === "accepted"
    && exactStringKeys(entry, [...baseKeys, "deliveryId"])
    && typeof entry.deliveryId === "string"
    && entry.deliveryId.length > 0
  ) return { ...base, state: "accepted", deliveryId: entry.deliveryId };
  if (entry.state === "terminal" && exactStringKeys(entry, [...baseKeys, "result"])) {
    return { ...base, state: "terminal", result: parseBossControlResult(entry.result) };
  }
  throw new Error("Invalid Boss ledger state discriminant");
}

export type BossControlLedgerLookup =
  | { status: "miss" }
  | { status: "conflict" }
  | { status: "accepted"; deliveryId: string }
  | { status: "replay"; result: BossControlResult };

/**
 * Boss bindings outlive transport reconnects and the ordinary recent-delivery
 * cache. Until the broker has an authoritative Boss run/binding teardown
 * signal, retaining every accepted binding and terminal tombstone is the only
 * fail-closed policy. Capacity exhaustion therefore rejects new work instead
 * of silently forgetting an idempotency scope.
 */
export class BossControlResultLedger {
  private state: BossControlLedgerState;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    const loaded = this.load();
    this.state = loaded.state;
    if (loaded.migrated) this.persist();
  }

  lookup(scope: string, fingerprint: string): BossControlLedgerLookup {
    const entry = this.state.entries.find((candidate) => candidate.scope === scope);
    if (!entry) return { status: "miss" };
    if (entry.fingerprint !== fingerprint) return { status: "conflict" };
    return entry.state === "accepted"
      ? { status: "accepted", deliveryId: entry.deliveryId }
      : { status: "replay", result: structuredClone(entry.result) };
  }

  recordAccepted(scope: string, fingerprint: string, deliveryId: string): void {
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

  recordTerminal(scope: string, fingerprint: string, resultValue: unknown): void {
    const result = parseBossControlResult(resultValue);
    canonicalJson(result);
    const existing = this.state.entries.find((entry) => entry.scope === scope);
    if (existing?.fingerprint !== undefined && existing.fingerprint !== fingerprint) {
      throw new Error("Boss idempotency scope is already bound to a different canonical request");
    }
    if (existing?.state === "terminal") {
      const existingStable = { ...existing.result, requestId: "<caller>", messageId: "<caller>" };
      const resultStable = { ...result, requestId: "<caller>", messageId: "<caller>" };
      if (canonicalJson(existingStable) !== canonicalJson(resultStable)) {
        throw new Error("Boss idempotency scope is already bound to a different canonical result");
      }
      return;
    }
    if (result.status === "delivered" || result.deliveryId !== undefined) {
      if (existing?.state !== "accepted" || existing.deliveryId !== result.deliveryId) {
        throw new Error("Boss terminal delivery requires the matching durable accepted state");
      }
    } else if (existing?.state === "accepted") {
      throw new Error("A terminal result after acceptance must carry the accepted deliveryId");
    }
    const terminal: TerminalBossControlLedgerEntry = {
      scope,
      fingerprint,
      state: "terminal",
      result,
    };
    if (existing) this.state.entries[this.state.entries.indexOf(existing)] = terminal;
    else {
      this.reserveCapacity();
      this.state.entries.push(terminal);
    }
    this.persist();
  }

  private reserveCapacity(): void {
    if (this.state.entries.length >= MAX_BOSS_CONTROL_RESULTS) {
      throw new Error("Durable Boss control ledger is full");
    }
  }

  private load(): { state: BossControlLedgerState; migrated: boolean } {
    if (!existsSync(this.path)) {
      return { state: { version: BOSS_CONTROL_LEDGER_VERSION, entries: [] }, migrated: false };
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      assertBossCanonicalData(parsed, "$.bossControlLedger");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed as Record<string, unknown>;
      if (
        !exactStringKeys(state, ["version", "entries"])
        || (state.version !== BOSS_CONTROL_LEDGER_VERSION && state.version !== EXPIRING_BOSS_CONTROL_LEDGER_VERSION)
        || !Array.isArray(state.entries)
      ) throw new Error("invalid ledger state");
      return {
        state: {
          version: BOSS_CONTROL_LEDGER_VERSION,
          entries: state.entries.map((entry) => parseEntry(entry, state.version as number)),
        },
        migrated: state.version === EXPIRING_BOSS_CONTROL_LEDGER_VERSION,
      };
    } catch (error) {
      const corruptPath = `${this.path}.corrupt-${this.now()}`;
      renameSync(this.path, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      throw new Error(`Boss control ledger was corrupt and quarantined at ${corruptPath}`, { cause: error });
    }
  }

  private persist(): void {
    writeDurableJson(this.path, this.state);
  }
}
