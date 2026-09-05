import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest } from "./mcp-protocol.ts";

function fakeRuntime() {
  return {
    whoami: async () => ({ content: [{ type: "text" as const, text: "me" }], structuredContent: { session_id: "s1" } }),
    team: async () => ({ content: [{ type: "text" as const, text: "Manager: manager-1" }], structuredContent: { manager: { target: "manager-1" } } }),
    join: async (name?: string, create?: boolean) => ({ content: [{ type: "text" as const, text: `join:${name ?? ""}:${create === true}` }] }),
    status: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    list: async () => ({ content: [{ type: "text" as const, text: "sessions" }], structuredContent: { sessions: [] } }),
    setSummary: async (summary: string) => ({ content: [{ type: "text" as const, text: `summary:${summary}` }] }),
    send: async (to: string, message: string) => ({ content: [{ type: "text" as const, text: `send:${to}:${message}` }] }),
    ask: async (to: string, message: string, _attachments?: unknown, timeoutMs?: number) => ({ content: [{ type: "text" as const, text: `ask:${to}:${message}:${timeoutMs ?? "default"}` }] }),
    pending: async () => ({ content: [{ type: "text" as const, text: "pending" }] }),
    reply: async (message: string) => ({ content: [{ type: "text" as const, text: `reply:${message}` }] }),
  } as any;
}

test("initialize returns MCP capabilities", async () => {
  const response = await handleMcpRequest({ id: 1, method: "initialize" }, fakeRuntime());

  assert.equal(response?.jsonrpc, "2.0");
  assert.deepEqual((response?.result as any).capabilities, { tools: {} });
});

test("tools/list includes every intercom tool with complete annotations", async () => {
  const response = await handleMcpRequest({ id: 2, method: "tools/list" }, fakeRuntime());
  const tools = (response?.result as any).tools as Array<{ name: string; annotations: Record<string, unknown>; inputSchema: any }>;

  assert.deepEqual(tools.map((tool) => tool.name), [
    "intercom_whoami",
    "intercom_team",
    "intercom_join",
    "intercom_status",
    "intercom_list",
    "intercom_set_summary",
    "intercom_send",
    "intercom_ask",
    "intercom_pending",
    "intercom_reply",
  ]);
  const expectedAnnotations: Record<string, Record<string, boolean>> = {
    intercom_whoami: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    intercom_team: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    intercom_join: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    intercom_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    intercom_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    intercom_set_summary: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    intercom_send: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    intercom_ask: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    intercom_pending: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    intercom_reply: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
  for (const tool of tools) assert.deepEqual(tool.annotations, expectedAnnotations[tool.name]);

  const reply = tools.find((tool) => tool.name === "intercom_reply")!;
  assert.ok(reply.inputSchema.properties.which);
  assert.equal(reply.inputSchema.properties.reply_to, undefined);
});

test("read and presence tools dispatch to their runtime handlers", async () => {
  const cases = [
    ["intercom_whoami", {}, "me"],
    ["intercom_team", {}, "Manager: manager-1"],
    ["intercom_join", { name: "billing" }, "join:billing:false"],
    ["intercom_status", {}, "ok"],
    ["intercom_list", {}, "sessions"],
    ["intercom_set_summary", { summary: "working" }, "summary:working"],
    ["intercom_pending", {}, "pending"],
  ] as const;

  for (const [name, args, expected] of cases) {
    const response = await handleMcpRequest({ id: `call-${name}`, method: "tools/call", params: { name, arguments: args } }, fakeRuntime());
    assert.equal(((response?.result as any).content[0]).text, expected);
  }
});

test("intercom_reply forwards the sender and oldest/latest selector", async () => {
  const runtime = fakeRuntime();
  runtime.reply = async (message: string, to?: string, which?: string) => ({ content: [{ type: "text" as const, text: `reply:${to}:${which}:${message}` }] });
  const response = await handleMcpRequest({ id: 21, method: "tools/call", params: { name: "intercom_reply", arguments: { to: "planner", which: "oldest", message: "answer" } } }, runtime);
  assert.equal(((response?.result as any).content[0]).text, "reply:planner:oldest:answer");
});

test("tools/call dispatches to the selected tool", async () => {
  const response = await handleMcpRequest({
    id: 3,
    method: "tools/call",
    params: {
      name: "intercom_send",
      arguments: { to: "worker", message: "hello" },
    },
  }, fakeRuntime());

  assert.equal(((response?.result as any).content[0]).text, "send:worker:hello");
});

test("tools/call passes ask timeout through", async () => {
  const response = await handleMcpRequest({
    id: 5,
    method: "tools/call",
    params: {
      name: "intercom_ask",
      arguments: { to: "worker", message: "hello", timeout_ms: 2500 },
    },
  }, fakeRuntime());

  assert.equal(((response?.result as any).content[0]).text, "ask:worker:hello:2500");
});

test("tools/call rejects ask timeouts above the interactive maximum", async () => {
  const response = await handleMcpRequest({
    id: 6,
    method: "tools/call",
    params: {
      name: "intercom_ask",
      arguments: { to: "worker", message: "hello", timeout_ms: 600000 },
    },
  }, fakeRuntime());

  assert.equal((response?.result as any).isError, true);
  assert.match(((response?.result as any).content[0]).text, /intercom_send plus intercom_pending/);
});

test("notifications/cancelled aborts a matching pending ask", async () => {
  let observedAbort = false;
  const runtime = {
    ...fakeRuntime(),
    ask: async (_to: string, _message: string, _attachments?: unknown, _timeoutMs?: number, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("aborted by test"));
      }, { once: true });
    }),
  } as any;

  const pending = handleMcpRequest({
    id: "ask-1",
    method: "tools/call",
    params: {
      name: "intercom_ask",
      arguments: { to: "worker", message: "hello" },
    },
  }, runtime);

  const cancelResponse = await handleMcpRequest({
    method: "notifications/cancelled",
    params: { requestId: "ask-1" },
  }, runtime);
  const response = await pending;

  assert.equal(cancelResponse, undefined);
  assert.equal(observedAbort, true);
  assert.equal((response?.result as any).isError, true);
  assert.match(((response?.result as any).content[0]).text, /aborted by test/);
});

test("tools/call reports validation errors as tool errors", async () => {
  const response = await handleMcpRequest({
    id: 4,
    method: "tools/call",
    params: {
      name: "intercom_send",
      arguments: { to: "worker" },
    },
  }, fakeRuntime());

  assert.equal((response?.result as any).isError, true);
  assert.match(((response?.result as any).content[0]).text, /message must be/);
});

test("notifications do not receive responses", async () => {
  const response = await handleMcpRequest({ method: "notifications/initialized" }, fakeRuntime());

  assert.equal(response, undefined);
});
