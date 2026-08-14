import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import net from "node:net";
import { once } from "node:events";
import { createMessageReader, writeMessage } from "../broker/framing.ts";

const repoDir = resolve(import.meta.dirname, "..");

async function withBroker(run: (socketPath: string, intercomDir: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "a4-"));
  const intercomDir = join(home, "intercom");
  const socketPath = join(intercomDir, "broker.sock");
  const broker = spawn(process.execPath, ["--import", "tsx", "broker/broker.ts"], {
    cwd: repoDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: home, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("broker startup timeout")), 10_000);
      broker.stdout.on("data", (d) => { if (d.toString().includes("Intercom broker started")) { clearTimeout(timeout); resolve(); } });
      broker.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`broker exited: ${code}`)); });
    });
    await run(socketPath, intercomDir);
  } catch (error) {
    broker.kill("SIGKILL");
    await once(broker, "exit").catch(() => undefined);
    throw error;
  } finally {
    const pid = broker.pid;
    broker.kill("SIGTERM");
    const exited = await Promise.race([once(broker, "exit").then(() => true).catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
    if (!exited) {
      broker.kill("SIGKILL");
      await Promise.race([once(broker, "exit").catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
    }
    let pidAbsent = false;
    try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") pidAbsent = true; }
    assert.equal(pidAbsent, true, `broker PID ${pid} still alive`);
    let socketAbsent = true;
    try { statSync(socketPath); socketAbsent = false; } catch { /* absent */ }
    assert.equal(socketAbsent, true, `socket ${socketPath} still present`);
    rmSync(home, { recursive: true, force: true });
    assert.equal(existsSync(home), false, `home ${home} still present`);
  }
}

class RawPeer {
  readonly messages: any[] = [];
  constructor(readonly socket: net.Socket) {
    socket.on("data", createMessageReader((m) => this.messages.push(m), () => socket.destroy()));
  }
  send(m: unknown): void { writeMessage(this.socket, m); }
  async waitFor(p: (m: any) => boolean, t = 3000): Promise<any> {
    const d = Date.now() + t;
    while (Date.now() < d) {
      const f = this.messages.find(p);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timeout, msgs=${JSON.stringify(this.messages)}`);
  }
}

function session(name: string, pid: number) {
  return { name, cwd: repoDir, model: "test", pid, startedAt: pid, lastActivity: Date.now() };
}

function localRegistration(sessionId: string, name: string, pid: number) {
  return { type: "register", protocol: "pi-intercom", version: 4, sessionId, session: session(name, pid) };
}

function remoteRegistration(sessionId: string, token: string, name: string, pid: number) {
  return { type: "register", protocol: "pi-intercom", version: 4, sessionId, access: { enrollmentToken: token }, session: session(name, pid) };
}

async function connect(path: string): Promise<RawPeer> {
  const socket = net.connect(path);
  await once(socket, "connect");
  return new RawPeer(socket);
}

test("remote enrollment token is not consumed by early validation failures", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath, intercomDir) => {
    const remotePath = join(intercomDir, "remote-gateway.sock");

    const root = await connect(socketPath);
    root.send(localRegistration("root-1", "root", 1));
    await root.waitFor((m) => m.type === "registered");

    const adminToken = JSON.parse(readFileSync(join(intercomDir, "broker-admin.json"), "utf8")).adminToken;
    async function issueEnrollment(name: string): Promise<string> {
      const admin = await connect(socketPath);
      admin.send({
        type: "access_control",
        requestId: `enroll-${name}`,
        adminToken,
        action: "issue_enrollment",
        enrollment: { name, parentSessionId: "root-1", rootSessionId: "root-1", remoteHostId: "host" },
      });
      const issued = await admin.waitFor((m) => m.type === "access_control_result" && m.requestId === `enroll-${name}`);
      return issued.enrollmentToken;
    }

    async function attemptInvalid(token: string, patch: (req: Record<string, any>) => void): Promise<any> {
      const peer = await connect(remotePath);
      const req = remoteRegistration("attacker", token, "attacker", 2) as Record<string, any>;
      patch(req);
      peer.send(req);
      const err = await peer.waitFor((m) => m.type === "error");
      peer.socket.destroy();
      return err;
    }

    async function validOnce(token: string, name: string): Promise<RawPeer> {
      const peer = await connect(remotePath);
      peer.send(remoteRegistration("ignored", token, name, 3));
      const registered = await peer.waitFor((m) => m.type === "registered");
      assert.equal(registered.type, "registered");
      return peer;
    }

    // 1. Protocol mismatch (v3) must not consume the token.
    const protocolToken = await issueEnrollment("proto");
    const protocolErr = await attemptInvalid(protocolToken, (req) => { req.version = 3; });
    assert.equal(protocolErr.code, "PROTOCOL_MISMATCH");
    const protocolValid = await validOnce(protocolToken, "proto-valid");

    // 2. Invalid scope metadata must not consume the token.
    const scopeToken = await issueEnrollment("scope");
    const scopeErr = await attemptInvalid(scopeToken, (req) => { req.scopeId = " invalid-scope"; });
    assert.equal(scopeErr.code, "INVALID_REQUEST");
    const scopeValid = await validOnce(scopeToken, "scope-valid");

    // 3. Invalid session metadata must not consume the token.
    const sessionToken = await issueEnrollment("session");
    const sessionErr = await attemptInvalid(sessionToken, (req) => { req.session = null; });
    assert.equal(sessionErr.code, "BOSS_CONTRACT_MISMATCH");
    const sessionValid = await validOnce(sessionToken, "session-valid");

    // 4. A consumed token cannot be reused.
    const reuse = await connect(remotePath);
    reuse.send(remoteRegistration("reuse", sessionToken, "reuse", 4));
    const reuseErr = await reuse.waitFor((m) => m.type === "error");
    assert.equal(reuseErr.code, "ACCESS_DENIED");

    root.socket.destroy();
    protocolValid.socket.destroy();
    scopeValid.socket.destroy();
    sessionValid.socket.destroy();
    reuse.socket.destroy();
  });
});

test("ask cancel, defer, and late reply act only on delivered edges", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const p1 = await connect(socketPath);
    p1.send(localRegistration("p1", "p1", 11));
    await p1.waitFor((m) => m.type === "registered");
    const p2 = await connect(socketPath);
    p2.send(localRegistration("p2", "p2", 12));
    await p2.waitFor((m) => m.type === "registered");

    async function deliverAsk(sender: RawPeer, recipient: RawPeer, id: string): Promise<void> {
      sender.send({ type: "send", to: recipient === p1 ? "p1" : "p2", message: { id, timestamp: Date.now(), expectsReply: true, content: { text: "q" } } });
      await sender.waitFor((m) => m.type === "delivery_accepted" && m.messageId === id);
      const message = await recipient.waitFor((m) => m.type === "message" && m.message.id === id);
      recipient.send({ type: "message_received", deliveryId: message.deliveryId });
      await sender.waitFor((m) => m.type === "delivered" && m.messageId === id);
    }

    // Cancel after the ask edge is fully delivered.
    await deliverAsk(p1, p2, "ask-cancel");
    p1.send({ type: "cancel_ask", requestId: "cancel-1", messageId: "ask-cancel" });
    const cancelResult = await p1.waitFor((m) => m.type === "ask_control_result" && m.requestId === "cancel-1");
    assert.equal(cancelResult.applied, true);
    await p2.waitFor((m) => m.type === "ask_cancelled" && m.messageId === "ask-cancel");

    // A reply to a cancelled ask must fail delivery.
    p2.send({ type: "send", to: "p1", message: { id: "late-reply", timestamp: Date.now(), replyTo: "ask-cancel", content: { text: "late" } } });
    const lateFailure = await p2.waitFor((m) => m.type === "delivery_failed" && m.messageId === "late-reply");
    assert.equal(lateFailure.code, "INVALID_REPLY_TARGET");

    // Defer after the ask edge is fully delivered.
    await deliverAsk(p1, p2, "ask-defer");
    p1.send({ type: "defer_ask", requestId: "defer-1", messageId: "ask-defer" });
    const deferResult = await p1.waitFor((m) => m.type === "ask_control_result" && m.requestId === "defer-1");
    assert.equal(deferResult.applied, true);
    await p2.waitFor((m) => m.type === "ask_deferred" && m.messageId === "ask-defer");

    p1.socket.destroy();
    p2.socket.destroy();
  });
});
