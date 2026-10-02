import test from "node:test";
import assert from "node:assert/strict";
import { VirtualCodexAgent, getCompletedIntercomSend, getApprovedIntercomSend, isIntercomToolApprovalRequest } from "./bridge-daemon.ts";
import type { IntercomClient } from "../broker/client.ts";

const sender = { id: "planner-id", name: "planner" };
function fixture() {
  const sends: any[] = [];
  const client = { async send(to: string, options: unknown) { sends.push({ to, options }); return { delivered: true, id: "sent" }; } };
  const agent = new VirtualCodexAgent({ id: "worker", name: "worker", cwd: "/tmp" }, {} as any, { agents: {} }, "/tmp/unused.json", {}, { client: client as unknown as IntercomClient });
  const internal = agent as any;
  internal.waiters.set("turn-alpha", [{ from: sender, message: { id: "ask-alpha", content: { text: "alpha", team: "alpha" } } }]);
  return { agent, internal, sends };
}

test("Codex worker automatic replies retain the original team", async () => {
  const { internal, sends } = fixture();
  internal.finalMessages.set("turn-alpha", "alpha answer");
  await internal.replyToWaiters("turn-alpha");
  assert.deepEqual(sends, [{ to: "planner-id", options: { text: "alpha answer", replyTo: "ask-alpha", team: "alpha" } }]);
});

test("a worker tool send in another task cannot consume an inbound ask", async () => {
  const { agent, internal, sends } = fixture();
  await agent.replyToWaitersFromIntercomSend("turn-alpha", { to: "planner", message: "beta work", team: "beta" });
  assert.equal(sends.length, 0);
  assert.equal(internal.waiters.get("turn-alpha").length, 1);
  await agent.replyToWaitersFromIntercomSend("turn-alpha", { to: "planner", message: "alpha answer", team: "alpha" });
  assert.equal(sends[0].options.team, "alpha");
  assert.equal(internal.waiters.has("turn-alpha"), false);
});

test("Codex approval and completed-send extraction preserve task selectors", () => {
  const args = { to: "planner", message: "work", team: "alpha" };
  assert.deepEqual(getCompletedIntercomSend({ item: { name: "intercom_send", arguments: args } }), args);
  assert.deepEqual(getApprovedIntercomSend({ serverName: "codex-intercom", _meta: { tool: "intercom_send", tool_params: args } }), args);
  assert.equal(isIntercomToolApprovalRequest({ serverName: "codex-intercom", _meta: { codex_approval_kind: "mcp_tool_call", tool: "intercom_join" } }), true);
});
