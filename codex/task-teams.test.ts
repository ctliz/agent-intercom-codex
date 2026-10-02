import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CodexIntercomRuntime as Runtime } from "./runtime.ts";
import type { IntercomClient, SendOptions } from "../broker/client.ts";
import type { SessionInfo, Message } from "../types.ts";
import { appendNamedTeamMembership, sessionNamedTeams, resolveNamedMessageTeam } from "./named-team-membership.ts";
import { listNamedTeams } from "./named-teams.ts";

const peer: SessionInfo = { id: "peer-id", name: "front", cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, status: "idle" };
class FakeClient extends EventEmitter {
  connected = false;
  sessionId = "self";
  sends: Array<{ to: string; options: SendOptions }> = [];
  onSend?: (options: SendOptions) => void;
  isConnected() { return this.connected; }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async listSessions() { return [peer]; }
  acknowledgeMessage() {}
  updatePresence() {}
  async cancelAsk() {}
  async deferAsk() {}
  async send(to: string, options: SendOptions) {
    this.sends.push({ to, options });
    this.onSend?.(options);
    return { delivered: true, id: options.messageId ?? "sent" };
  }
  receive(id: string, team?: string, expectsReply = true, replyTo?: string) {
    const message: Message = { id, timestamp: Date.now(), expectsReply, replyTo, content: { text: id, ...(team ? { team } : {}) } };
    this.emit("message", peer, message, `delivery-${id}`);
  }
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "intercom-task-teams-"));
  const keys = ["PI_CODING_AGENT_DIR", "AGENT_INTERCOM_SCOPE_ID", "AGENT_INTERCOM_MANAGER_TARGET", "CLAUDE_INTERCOM_INBOX"];
  const previous = keys.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CLAUDE_INTERCOM_INBOX = join(dir, "inbox.jsonl");
  delete process.env.AGENT_INTERCOM_SCOPE_ID;
  delete process.env.AGENT_INTERCOM_MANAGER_TARGET;
  const client = new FakeClient();
  const identity = { sessionId: "self", name: "planner", cwd: dir, model: "test", startedAt: Date.now() };
  const options = { clientFactory: () => client as unknown as IntercomClient, prepareConnection: async () => {} };
  const runtime = new Runtime(identity, options);
  t.after(async () => {
    await runtime.disconnect();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    rmSync(dir, { recursive: true, force: true });
  });
  await runtime.connect();
  return { dir, runtime, client };
}

test("manager adds peers atomically; memberships and per-task roles are additive", async (t) => {
  const { dir, runtime } = await fixture(t);
  assert.equal((await runtime.join("launch", true, ["front"], "Launch page")).isError, undefined);
  await appendNamedTeamMembership({ name: "review", selfId: peer.id, members: ["self"], create: true, agentDir: dir });
  assert.deepEqual(sessionNamedTeams("self", dir).map((team) => team.name), ["launch", "review"]);
  const rosters = (await runtime.team()).structuredContent?.teams as Array<{ name: string; self: { isManager: boolean } }>;
  assert.deepEqual(rosters.map((team) => team.self.isManager), [true, false]);
  assert.equal(process.env.AGENT_INTERCOM_SCOPE_ID, undefined);
  assert.equal(process.env.AGENT_INTERCOM_MANAGER_TARGET, undefined);
  assert.equal((await runtime.join("broken", true, ["missing"])).isError, true);
  assert.deepEqual(listNamedTeams(dir).map((team) => team.name), ["launch", "review"]);
  await assert.rejects(appendNamedTeamMembership({ name: "launch", selfId: peer.id, members: ["outsider"], agentDir: dir }), /Only the manager/);
});

test("ungrouped contact survives unrelated memberships; shared task ambiguity requires team", async (t) => {
  const { dir, runtime, client } = await fixture(t);
  await runtime.join("mine", true);
  await appendNamedTeamMembership({ name: "theirs", selfId: peer.id, create: true, agentDir: dir });
  await runtime.send("front", "initial contact");
  assert.equal(client.sends.at(-1)?.options.team, undefined);
  assert.equal(listNamedTeams(dir).length, 2);
  await runtime.join("mine", false, ["front"]);
  await runtime.send("front", "one shared task");
  assert.equal(client.sends.at(-1)?.options.team, "mine");
  await runtime.join("second", true, ["front"]);
  await assert.rejects(runtime.send("front", "ambiguous"), /Multiple shared teams/);
  await runtime.send("front", "explicit", undefined, undefined, "second");
  assert.equal(client.sends.at(-1)?.options.team, "second");
  assert.throws(() => resolveNamedMessageTeam("self", "outsider", "mine", dir), /Both sessions/);
});

test("mixed-team asks require exact context; replies inherit source and cannot override", async (t) => {
  const { runtime, client } = await fixture(t);
  await runtime.join("alpha", true, ["front"]);
  await runtime.join("beta", true, ["front"]);
  client.receive("first", "alpha");
  client.receive("second", "beta");
  const pending = await runtime.pending();
  assert.match(pending.content[0]!.text, /\[Team: alpha\]/);
  const asks = pending.structuredContent?.pending_asks as Array<{ askId: string; contextId: string; team: string }>;
  assert.equal((await runtime.reply("ambiguous")).isError, true);
  assert.equal((await runtime.reply("wrong team", undefined, undefined, asks[0]!.askId, undefined, "beta")).isError, true);
  assert.equal(client.sends.length, 0);
  assert.equal((await runtime.reply("answer alpha", undefined, undefined, asks[0]!.askId)).isError, undefined);
  assert.equal(client.sends[0]?.options.team, "alpha");
  assert.equal(client.sends[0]?.options.replyTo, "first");
  assert.equal((await runtime.reply("stale", undefined, undefined, asks[0]!.askId)).isError, true);
  assert.equal((await runtime.reply("stale context", undefined, undefined, undefined, asks[0]!.contextId)).isError, true);
  assert.equal((await runtime.pending()).structuredContent?.pending_asks instanceof Array, true);
  assert.equal((await runtime.reply("answer beta", undefined, undefined, undefined, asks[1]!.contextId)).isError, undefined);
  assert.equal(client.sends.at(-1)?.options.team, "beta");
});

test("ordinary and ungrouped reply contexts do not adopt newly shared teams", async (t) => {
  const { runtime, client } = await fixture(t);
  client.receive("ordinary", undefined, false);
  const messages = (await runtime.pending()).structuredContent?.unread_messages as Array<{ contextId: string }>;
  await runtime.join("newtask", true, ["front"]);
  assert.equal((await runtime.reply("bad selector", undefined, undefined, undefined, "ctx-unknown")).isError, true);
  assert.equal((await runtime.reply("bad sender", "outsider", undefined, undefined, messages[0]!.contextId)).isError, true);
  assert.equal((await runtime.reply("ack", undefined, undefined, undefined, messages[0]!.contextId)).isError, undefined);
  assert.equal(client.sends.at(-1)?.options.replyTo, undefined);
  assert.equal(client.sends.at(-1)?.options.team, undefined);
});

test("a reply in another team cannot unblock the ask waiter", async (t) => {
  const { runtime, client } = await fixture(t);
  await runtime.join("alpha", true, ["front"]);
  client.onSend = (options) => {
    if (!options.expectsReply) return;
    client.receive("wrong-reply", "beta", false, options.messageId);
    client.receive("right-reply", "alpha", false, options.messageId);
  };
  const result = await runtime.ask("front", "question", undefined, 1000, undefined, "alpha");
  assert.equal(result.isError, undefined);
  assert.match(result.content[0]!.text, /right-reply/);
  assert.match((await runtime.pending()).content[0]!.text, /wrong-reply/);
});

test("independent processes cannot lose overlapping team membership updates", async (t) => {
  const { dir } = await fixture(t);
  await appendNamedTeamMembership({ name: "parallel", selfId: "manager", create: true, agentDir: dir });
  const moduleUrl = new URL("./named-team-membership.ts", import.meta.url).href;
  await Promise.all(["a", "b", "c", "d"].map((selfId) => new Promise<void>((resolve, reject) => {
    const script = `import { appendNamedTeamMembership } from ${JSON.stringify(moduleUrl)}; await appendNamedTeamMembership(${JSON.stringify({ name: "parallel", selfId, agentDir: dir })});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.deepEqual(listNamedTeams(dir)[0]!.memberSessionIds?.sort(), ["a", "b", "c", "d", "manager"]);
});
