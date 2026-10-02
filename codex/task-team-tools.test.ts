import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest } from "./mcp-protocol.ts";

function runtimeSpy() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const runtime = Object.fromEntries(["whoami", "team", "join", "status", "list", "setSummary", "send", "ask", "pending", "reply"].map((method) => [method, async (...args: unknown[]) => {
    calls.push({ method, args });
    return { content: [{ type: "text", text: "ok" }] };
  }]));
  return { runtime: runtime as any, calls };
}

test("MCP initialization supplies one-time consent and original-team reply guidance", async () => {
  const { runtime } = runtimeSpy();
  const result = (await handleMcpRequest({ id: 1, method: "initialize" }, runtime))?.result as any;
  assert.match(result.instructions, /ask once/);
  assert.match(result.instructions, /Wait for approval/);
  assert.match(result.instructions, /Membership is additive/);
  assert.match(result.instructions, /ungrouped/);
  assert.match(result.instructions, /original message's team/);
});

test("MCP task-team schemas and handlers preserve every public selector", async () => {
  const { runtime, calls } = runtimeSpy();
  const tools = (await handleMcpRequest({ id: 1, method: "tools/list" }, runtime))?.result as any;
  const properties = (name: string) => tools.tools.find((tool: any) => tool.name === name).inputSchema.properties;
  assert.ok(properties("intercom_join").members);
  assert.ok(properties("intercom_join").work);
  for (const tool of ["intercom_team", "intercom_send", "intercom_ask", "intercom_reply"]) assert.ok(properties(tool).team);
  assert.ok(properties("intercom_reply").askId);
  assert.ok(properties("intercom_reply").contextId);
  const call = (name: string, args: Record<string, unknown>) => handleMcpRequest({ id: name, method: "tools/call", params: { name, arguments: args } }, runtime);
  await call("intercom_join", { name: "launch", create: true, members: ["front"], work: "Task" });
  assert.deepEqual(calls.at(-1), { method: "join", args: ["launch", true, ["front"], "Task"] });
  await call("intercom_team", { team: "launch" });
  assert.deepEqual(calls.at(-1), { method: "team", args: ["launch"] });
  await call("intercom_send", { to: "front", message: "work", team: "launch" });
  assert.equal(calls.at(-1)?.args[4], "launch");
  await call("intercom_ask", { to: "front", message: "question", team: "launch" });
  assert.equal(calls.at(-1)?.args[5], "launch");
  await call("intercom_reply", { message: "answer", askId: "ask-1", team: "launch" });
  assert.deepEqual(calls.at(-1), { method: "reply", args: ["answer", undefined, undefined, "ask-1", undefined, "launch"] });
  await call("intercom_reply", { message: "ack", contextId: "ctx-1" });
  assert.equal(calls.at(-1)?.args[4], "ctx-1");
  const count = calls.length;
  for (const members of ["front", [null], Array(1)]) {
    const error = (await call("intercom_join", { name: "launch", members }))?.result as any;
    assert.equal(error.isError, true);
  }
  assert.equal(calls.length, count);
});
