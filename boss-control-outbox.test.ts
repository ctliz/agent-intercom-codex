import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { BOSS_CONTROL_ENVELOPE_VERSION } from "@ctliz/agent-intercom-core/boss";
import { PersistentBossControlOutbox } from "./boss-control-outbox.ts";

const envelope = {
  type: "boss.worker.health" as const,
  version: BOSS_CONTROL_ENVELOPE_VERSION,
  messageId: "message-1",
  bossRunId: "run-1",
  participantId: "worker-1",
  bindingEpoch: 1,
  idempotencyKey: "operation-1",
  payload: { state: "working" },
};

test("stable idempotency with a new messageId keeps one canonical request and the new caller correlation", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-control-outbox-"));
  try {
    const outbox = new PersistentBossControlOutbox("session-1", dir);
    assert.equal(outbox.enqueue("target-session", envelope), "added");
    assert.equal(outbox.enqueue("target-session", {
      payload: { state: "working" },
      idempotencyKey: "operation-1",
      bindingEpoch: 1,
      participantId: "worker-1",
      bossRunId: "run-1",
      messageId: "message-2",
      version: BOSS_CONTROL_ENVELOPE_VERSION,
      type: "boss.worker.health",
    }), "existing");
    assert.equal(outbox.list().length, 1);
    assert.equal(outbox.list()[0]?.envelope.messageId, "message-2");
    assert.throws(() => outbox.enqueue("other-session", envelope), /different canonical request/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("result-order probes require durable ACK and exact deliveryId before outbox removal", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-control-outbox-order-"));
  try {
    const outbox = new PersistentBossControlOutbox("session-1", dir);
    outbox.enqueue("target-session", envelope);
    assert.throws(() => outbox.removeCorrelated("operation-1", "message-1", "delivery-1"), /before the matching durable acknowledgement/);
    assert.equal(outbox.markAccepted("operation-1", "message-1", "delivery-1"), "accepted");
    assert.equal(new PersistentBossControlOutbox("session-1", dir).find("operation-1")?.state, "accepted");
    assert.equal(outbox.markAccepted("operation-1", "message-1", "delivery-1"), "already-accepted");
    assert.throws(() => outbox.removeCorrelated("operation-1", "message-1", "delivery-2"), /before the matching durable acknowledgement/);
    assert.throws(() => outbox.removeCorrelated("operation-1", "message-1"), /omitted the durable deliveryId/);
    outbox.removeCorrelated("operation-1", "message-1", "delivery-1");
    assert.deepEqual(new PersistentBossControlOutbox("session-1", dir).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt Boss outbox is quarantined and fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-control-outbox-corrupt-"));
  try {
    const outboxDir = join(dir, "boss-control-outbox");
    mkdirSync(outboxDir, { recursive: true });
    const file = `${createHash("sha256").update("session-1").digest("hex")}.json`;
    writeFileSync(join(outboxDir, file), "{not-json");
    assert.throws(() => new PersistentBossControlOutbox("session-1", dir), /corrupt and quarantined/);
    assert.match(readdirSync(outboxDir)[0] ?? "", new RegExp(`^${file}\\.corrupt-`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
