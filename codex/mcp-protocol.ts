import type { CodexIntercomRuntime, ToolResult } from "./runtime.ts";
import { validateAskTimeoutMs } from "../config.ts";
import { TASK_TEAM_GUIDANCE } from "./team-guidance.ts";
import type { Attachment } from "../types.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type RequestId = string | number;
type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  handler: ToolHandler;
}

const inflightToolCalls = new Map<RequestId, AbortController>();

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : asString(value, name);
}

function memberArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("members must be an array of session names or IDs");
  return Array.from(value, (member) => asString(member, "member"));
}

function asBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function asOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return validateAskTimeoutMs(value, name);
}

function asAttachmentArray(value: unknown): Attachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`attachments[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    const type = raw.type;
    if (type !== "file" && type !== "snippet" && type !== "context") throw new Error(`attachments[${index}].type must be file, snippet, or context`);
    const name = asString(raw.name, `attachments[${index}].name`);
    const content = asString(raw.content, `attachments[${index}].content`);
    if (raw.language !== undefined && typeof raw.language !== "string") throw new Error(`attachments[${index}].language must be a string`);
    const language = typeof raw.language === "string" ? raw.language : undefined;
    return { type, name, content, ...(language ? { language } : {}) };
  });
}

const attachmentsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["file", "snippet", "context"] },
      name: { type: "string" },
      content: { type: "string" },
      language: { type: "string" },
    },
    required: ["type", "name", "content"],
    additionalProperties: false,
  },
};

export function buildToolDefinitions(runtime: CodexIntercomRuntime): ToolDefinition[] {
  return [
    {
      name: "intercom_whoami",
      description: "Return this Codex session's intercom identity for reliable targeting.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async () => runtime.whoami(),
    },
    {
      name: "intercom_team",
      description: "Show all your named task teams, or inspect one by name. Falls back to managed-team discovery.",
      inputSchema: { type: "object", properties: { team: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args) => runtime.team(optionalString(args.team, "team")),
    },
    {
      name: "intercom_join",
      description: "After user approval, create or join a task team. Membership is additive; members lets the manager add connected peers in one call. Omit name to list teams.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Team name to join. Omit to list joinable teams." },
          create: { type: "boolean", description: "Create this named team and join as manager. Requires name." },
          members: { type: "array", items: { type: "string" }, description: "Connected session names or IDs to add; manager only." },
          work: { type: "string", maxLength: 2000, description: "Task description when creating a team." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args) => runtime.join(
        optionalString(args.name, "name"),
        args.create === true,
        memberArray(args.members),
        optionalString(args.work, "work"),
      ),
    },
    {
      name: "intercom_status",
      description: "Show intercom connection status, active sessions, unread messages, and pending asks.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async () => runtime.status(),
    },
    {
      name: "intercom_list",
      description: "List intercom-connected Pi or Codex sessions on this machine.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["machine", "directory", "repo"], default: "machine" },
          include_self: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args) => runtime.list(
        args.scope === "directory" || args.scope === "repo" ? args.scope : "machine",
        asBoolean(args.include_self, false),
      ),
    },
    {
      name: "intercom_set_summary",
      description: "Publish a short status summary so other sessions can discover what this Codex session is doing.",
      inputSchema: {
        type: "object",
        properties: { summary: { type: "string", maxLength: 400 } },
        required: ["summary"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      handler: async (args) => runtime.setSummary(asString(args.summary, "summary")),
    },
    {
      name: "intercom_send",
      description: "Send a non-blocking direct message to another intercom session by name, full ID, or unique ID prefix.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          message: { type: "string" },
          attachments: attachmentsSchema,
          team: { type: "string", description: "Task team; required when multiple teams are shared. Omit for ungrouped contact." },
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args) => runtime.send(asString(args.to, "to"), asString(args.message, "message"), asAttachmentArray(args.attachments), undefined, optionalString(args.team, "team")),
    },
    {
      name: "intercom_ask",
      description: "Ask another intercom session a question only when the next step depends on its reply. Use intercom_send for assignments, progress/status checkpoints, and notifications.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          message: { type: "string" },
          attachments: attachmentsSchema,
          team: { type: "string", description: "Task team; required when multiple teams are shared." },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000, description: "Maximum time to wait for a reply before returning an error. Use intercom_send plus intercom_pending for longer work." },
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args, signal) => runtime.ask(
        asString(args.to, "to"),
        asString(args.message, "message"),
        asAttachmentArray(args.attachments),
        asOptionalPositiveInteger(args.timeout_ms, "timeout_ms"),
        signal,
        optionalString(args.team, "team"),
      ),
    },
    {
      name: "intercom_pending",
      description: "Read unread inbound messages and unresolved asks for this Codex session.",
      inputSchema: {
        type: "object",
        properties: { mark_read: { type: "boolean", default: false } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      handler: async (args) => runtime.pending(asBoolean(args.mark_read, false)),
    },
    {
      name: "intercom_reply",
      description: "Reply to an inbound ask or ordinary message using askId or contextId from intercom_pending. Inherits the original team; team cannot override it.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          to: { type: "string", description: "Optional sender/session selector; never a message or thread ID." },
          askId: { type: "string", description: "Stable receiver-local pending ask selector." },
          contextId: { type: "string", description: "Exact inbound context selector, including ordinary messages." },
          team: { type: "string", description: "Must match the original message; omit to inherit." },
          which: { type: "string", enum: ["oldest", "latest"], description: "Select the oldest or latest ask from the chosen sender." },
        },
        required: ["message"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      handler: async (args) => runtime.reply(asString(args.message, "message"), typeof args.to === "string" ? args.to : undefined, args.which === "oldest" || args.which === "latest" ? args.which : undefined, optionalString(args.askId, "askId"), optionalString(args.contextId, "contextId"), optionalString(args.team, "team")),
    },
  ];
}

function ok(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcpRequest(request: JsonRpcRequest, runtime: CodexIntercomRuntime): Promise<Record<string, unknown> | undefined> {
  if (!request.method) {
    return error(request.id, -32600, "Invalid request");
  }

  if (request.method === "notifications/cancelled") {
    const requestId = request.params?.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      inflightToolCalls.get(requestId)?.abort();
    }
    return undefined;
  }

  if (request.id === undefined && request.method.startsWith("notifications/")) {
    return undefined;
  }

  const tools = buildToolDefinitions(runtime);
  switch (request.method) {
    case "initialize":
      return ok(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        instructions: TASK_TEAM_GUIDANCE,
        serverInfo: { name: "codex-intercom", version: "0.13.0" },
      });
    case "ping":
      return ok(request.id, {});
    case "tools/list":
      return ok(request.id, {
        tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const name = request.params?.name;
      const args = request.params?.arguments;
      if (typeof name !== "string") return error(request.id, -32602, "tools/call requires params.name");
      if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) {
        return error(request.id, -32602, "tools/call params.arguments must be an object");
      }
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return error(request.id, -32602, `Unknown tool: ${name}`);
      const requestId = request.id;
      const abortController = typeof requestId === "string" || typeof requestId === "number"
        ? new AbortController()
        : null;
      if (abortController && requestId !== undefined) inflightToolCalls.set(requestId, abortController);
      try {
        return ok(request.id, await tool.handler((args ?? {}) as Record<string, unknown>, abortController?.signal));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return ok(request.id, { content: [{ type: "text", text: message }], isError: true });
      } finally {
        if (abortController && requestId !== undefined) inflightToolCalls.delete(requestId);
      }
    }
    default:
      return error(request.id, -32601, `Method not found: ${request.method}`);
  }
}
