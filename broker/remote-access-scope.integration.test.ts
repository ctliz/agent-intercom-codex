import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import net from "node:net";
import { createMessageReader, writeMessage } from "./framing.ts";

const repoDir = resolve(import.meta.dirname, "..");

class RawPeer {
  readonly messages: unknown[] = [];
  constructor(readonly socket: net.Socket) {
    socket.on("data", createMessageReader((message) => this.messages.push(message), () => socket.destroy()));
  }
  send(message: unknown): void { writeMessage(this.socket, message); }
  async waitFor(predicate: (message: any) => boolean, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out; received ${JSON.stringify(this.messages)}`);
  }
}

async function connect(path: string): Promise<RawPeer> {
  const socket = net.connect(path);
  await once(socket, "connect");
  return new RawPeer(socket);
}

test("remote and Boss sessions are partitioned by scope", { timeout: 20_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "irgs-"));
  const intercomDir = join(agentDir, "intercom");
  const localPath = join(intercomDir, "broker.sock");
  
  // Set scope for this test
  const broker = spawn(process.execPath, ["--import", "tsx", join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, AGENT_INTERCOM_SCOPE_ID: "Scope_AAAAAAAAAA", PI_CODING_AGENT_DIR: agentDir, HOME: agentDir, USERPROFILE: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("broker startup timeout")), 10_000);
        broker.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("Intercom broker started")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        broker.once("exit", (code) => reject(new Error(`broker exited: ${code}`)));
    });

    const peerA = await connect(localPath);
    peerA.send({ type: "register", protocol: "pi-intercom", version: 4, sessionId: "a-id", scopeId: "Scope_AAAAAAAAAA", session: { name: "a", cwd: repoDir, model: "test", pid: 1, startedAt: 1, lastActivity: 1 } });
    await peerA.waitFor((m) => m.type === "registered");

    const peerB = await connect(localPath);
    peerB.send({ type: "register", protocol: "pi-intercom", version: 4, sessionId: "b-id", scopeId: "Scope_BBBBBBBBBB", session: { name: "b", cwd: repoDir, model: "test", pid: 2, startedAt: 2, lastActivity: 2 } });
    await peerB.waitFor((m) => m.type === "registered"); // Expect success, they are just in different scopes

    peerA.send({ type: "list", requestId: "list-a" });
    const listA = await peerA.waitFor((m) => m.type === "sessions" && m.requestId === "list-a");
    assert.ok(!listA.sessions.find((s: any) => s.id === "b-id"));

    peerB.send({ type: "list", requestId: "list-b" });
    const listB = await peerB.waitFor((m) => m.type === "sessions" && m.requestId === "list-b");
    assert.ok(!listB.sessions.find((s: any) => s.id === "a-id"));

  } finally {
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    rmSync(agentDir, { recursive: true, force: true });
  }
});
