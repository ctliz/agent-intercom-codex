import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOSS_CONTROL_ENVELOPE_VERSION } from "@ctliz/agent-intercom-core/boss";
import { IntercomClient } from "./client.ts";
import { PersistentBossControlOutbox } from "../boss-control-outbox.ts";

test("cancelAsk resolves false after synchronous socket write failures", async () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      throw new Error("write failed");
    },
  };

  assert.equal(await client.cancelAsk("ask-1"), false);
});

test("client registration preflight is exact and rejects proxies with zero traps before connect", async () => {
  const client = new IntercomClient();
  let trapCount = 0;
  const proxy = new Proxy({}, {
    get() { trapCount += 1; throw new Error("trap"); },
    ownKeys() { trapCount += 1; throw new Error("trap"); },
    getOwnPropertyDescriptor() { trapCount += 1; throw new Error("trap"); },
    getPrototypeOf() { trapCount += 1; throw new Error("trap"); },
  });
  await assert.rejects(client.connect(proxy as never), /proxies are not supported/);
  assert.equal(trapCount, 0);
  await assert.rejects(client.connect({
    cwd: "/tmp",
    model: "gpt",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    capabilities: {},
  } as never), /not supported/);
});

test("caller and inbound Boss envelopes reject outer and nested proxies with zero traps before Core parsing", async () => {
  const client = new IntercomClient() as any;
  client._sessionId = "session-1";
  client.socket = { destroyed: false, writableEnded: false, writable: true };
  const from = { id: "sender", cwd: "/tmp", model: "gpt", pid: 1, startedAt: 1, lastActivity: 1 };

  for (const nested of [false, true]) {
    let trapCount = 0;
    const proxy = new Proxy({}, {
      get() { trapCount += 1; throw new Error("trap"); },
      ownKeys() { trapCount += 1; throw new Error("trap"); },
      getOwnPropertyDescriptor() { trapCount += 1; throw new Error("trap"); },
      getPrototypeOf() { trapCount += 1; throw new Error("trap"); },
    });
    const envelope = nested ? {
      type: "boss.worker.health",
      version: BOSS_CONTROL_ENVELOPE_VERSION,
      messageId: "message-proxy",
      bossRunId: "run-1",
      participantId: "worker-1",
      bindingEpoch: 1,
      idempotencyKey: "operation-proxy",
      payload: proxy,
    } : proxy;

    await assert.rejects(client.sendBossControl("target", envelope), /proxies are not supported/);
    assert.equal(trapCount, 0, `${nested ? "nested" : "outer"} caller proxy must remain untouched`);
    assert.throws(
      () => client.handleBrokerMessage({ type: "boss_control", deliveryId: "delivery-proxy", from, envelope }),
      /proxies are not supported/,
    );
    assert.equal(trapCount, 0, `${nested ? "nested" : "outer"} inbound proxy must remain untouched`);
  }
});

test("client Boss response state machine accepts only an identical replay ACK and rejects changed correlation", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-client-order-"));
  try {
    const client = new IntercomClient() as any;
    client._sessionId = "session-1";
    client.bossControlOutbox = new PersistentBossControlOutbox("session-1", dir);
    const envelope = {
      type: "boss.worker.health",
      version: BOSS_CONTROL_ENVELOPE_VERSION,
      messageId: "message-1",
      bossRunId: "run-1",
      participantId: "worker-1",
      bindingEpoch: 1,
      idempotencyKey: "operation-1",
      payload: { state: "working" },
    };
    client.bossControlOutbox.enqueue("target-1", envelope);
    const timeout = setTimeout(() => undefined, 60_000);
    timeout.unref();
    client.pendingBossControls.set("message-1", {
      messageId: "message-1",
      idempotencyKey: "operation-1",
      resolve() {},
      reject() {},
      timeout,
    });
    const result = {
      type: "boss_control_result",
      requestId: "message-1",
      messageId: "message-1",
      idempotencyKey: "operation-1",
      status: "delivered",
      delivered: true,
      deliveryId: "delivery-1",
    };
    assert.throws(() => client.handleBrokerMessage(result), /before the matching durable acknowledgement/);
    assert.equal(client.bossControlOutbox.list().length, 1);
    const ack = {
      type: "boss_control_ack",
      requestId: "message-1",
      messageId: "message-1",
      idempotencyKey: "operation-1",
      status: "accepted",
      deliveryId: "delivery-1",
    };
    client.handleBrokerMessage(ack);
    assert.doesNotThrow(() => client.handleBrokerMessage(ack));
    assert.throws(
      () => client.handleBrokerMessage({ ...ack, deliveryId: "delivery-2" }),
      /changed the durable deliveryId/,
    );
    assert.throws(
      () => client.handleBrokerMessage({ ...ack, requestId: "message-2", messageId: "message-2" }),
      /does not match the durable outbox binding/,
    );
    assert.throws(
      () => client.handleBrokerMessage({ ...ack, idempotencyKey: "operation-2" }),
      /correlation does not match the pending request/,
    );
    client.pendingBossControls.clear();
    assert.doesNotThrow(
      () => client.handleBrokerMessage(ack),
      "a reconnect without pending memory must accept the exact durable replay ACK",
    );
    assert.throws(() => client.handleBrokerMessage({ ...result, deliveryId: "delivery-2" }), /matching durable acknowledgement/);
    assert.equal(client.bossControlOutbox.list().length, 1);
    client.handleBrokerMessage(result);
    assert.deepEqual(client.bossControlOutbox.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reconnected caller consumes replayed ACK then terminal and clears its durable outbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-client-reconnect-terminal-"));
  try {
    const durable = new PersistentBossControlOutbox("session-1", dir);
    durable.enqueue("target-1", {
      type: "boss.worker.health",
      version: BOSS_CONTROL_ENVELOPE_VERSION,
      messageId: "message-1",
      bossRunId: "run-1",
      participantId: "worker-1",
      bindingEpoch: 1,
      idempotencyKey: "operation-1",
      payload: { state: "working" },
    });
    durable.markAccepted("operation-1", "message-1", "delivery-1");

    const reconnected = new IntercomClient() as any;
    reconnected._sessionId = "session-1";
    reconnected.bossControlOutbox = new PersistentBossControlOutbox("session-1", dir);
    assert.doesNotThrow(() => reconnected.handleBrokerMessage({
      type: "boss_control_ack",
      requestId: "message-1",
      messageId: "message-1",
      idempotencyKey: "operation-1",
      status: "accepted",
      deliveryId: "delivery-1",
    }));
    assert.doesNotThrow(() => reconnected.handleBrokerMessage({
      type: "boss_control_result",
      requestId: "message-1",
      messageId: "message-1",
      idempotencyKey: "operation-1",
      status: "delivered",
      delivered: true,
      deliveryId: "delivery-1",
    }));
    assert.deepEqual(reconnected.bossControlOutbox.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reconstructed caller accepts its one first ACK when the durable outbox is still queued", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-client-reconstructed-"));
  try {
    const client = new IntercomClient() as any;
    client._sessionId = "session-1";
    client.bossControlOutbox = new PersistentBossControlOutbox("session-1", dir);
    client.bossControlOutbox.enqueue("target-1", {
      type: "boss.worker.health",
      version: BOSS_CONTROL_ENVELOPE_VERSION,
      messageId: "message-1",
      bossRunId: "run-1",
      participantId: "worker-1",
      bindingEpoch: 1,
      idempotencyKey: "operation-1",
      payload: { state: "working" },
    });
    assert.doesNotThrow(() => client.handleBrokerMessage({
      type: "boss_control_ack",
      requestId: "message-1",
      messageId: "message-1",
      idempotencyKey: "operation-1",
      status: "accepted",
      deliveryId: "delivery-1",
    }));
    assert.equal(client.bossControlOutbox.list()[0].state, "accepted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
