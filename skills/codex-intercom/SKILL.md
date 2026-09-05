---
name: codex-intercom
description: |
  Coordinate with local Pi or Codex sessions through pi-intercom MCP tools.
  Use for same-machine planner-worker workflows, direct peer questions,
  cross-session context sharing, and checking or replying to pending asks.
---

# Codex Intercom

Use this skill when you need to coordinate with another local coding-agent
session through the `pi-intercom` MCP server.

Codex cannot currently receive unsolicited MCP messages as a fresh visible turn.
Inbound messages are queued by the MCP server while it is running. Check
`intercom_pending` at natural boundaries, before starting delegated work, and
when you expect a response.

If the user needs wake-on-message behavior, use or recommend the app-server
bridge daemon. It exposes configured virtual Codex workers as intercom sessions;
messages to those workers create or resume app-server threads and start turns.

## Tools

- `intercom_whoami`: show this session's intercom ID, name, cwd, and model.
- `intercom_team`: show the current orchestrator manager and live same-manager coworkers.
- `intercom_join`: list, join, or create a named team without tmux (`create: true` joins as manager).
- `intercom_status`: check connection, active session count, unread messages,
  and unresolved inbound asks.
- `intercom_list`: list connected Pi and Codex sessions.
- `intercom_set_summary`: publish a short discoverable status.
- `intercom_send`: fire-and-forget direct message.
- `intercom_ask`: send a question and wait for the target's reply.
- `intercom_pending`: read queued inbound messages and pending asks.
- `intercom_reply`: reply to a pending inbound ask.

## Workflow

1. Call `intercom_status` or `intercom_whoami` to verify this session is
   connected.
2. Call `intercom_set_summary` with a concise status when other sessions need
   to discover your role.
3. If this is an orchestrator-owned coworker, call `intercom_team` to get the manager and sibling targets without searching globally. To form a team without tmux, call `intercom_join({ name: "billing", create: true })` in one session and `intercom_join({ name: "billing" })` in the others. Otherwise use `intercom_list`.
4. Use `intercom_send` for non-blocking updates and handoffs.
5. Use `intercom_ask` only when you need the answer before continuing. Assignments, progress/status checkpoints, notifications, and completion reports use `intercom_send`.
6. Call `intercom_pending` before ending a coordination turn, then answer
   blocking asks with `intercom_reply`.

## Patterns

Planner delegates without waiting:

```typescript
intercom_send({
  to: "worker",
  message: "Task-3: Add retry logic in src/api/client.ts. Ask if the retry scope is unclear."
})
```

Worker asks and waits:

```typescript
intercom_ask({
  to: "planner",
  message: "Should retry apply only to idempotent endpoints? Proposed: GET/PUT/DELETE, max 3, exponential backoff."
})
```

Reply to an inbound ask:

```typescript
intercom_pending({ mark_read: false })
intercom_reply({ message: "Use GET/PUT/DELETE only, max 3 retries." })
```

When multiple asks are pending, select the sender with `to`. If that sender has multiple unresolved asks, select `oldest` or `latest` without using protocol IDs:

```typescript
intercom_reply({
  to: "planner",
  which: "oldest",
  message: "Proceed, but preserve the public error shape."
})
```

Keep at most one unresolved `intercom_ask` to the same recipient. Use `intercom_send` for non-blocking follow-ups and every progress/status request.

Wake a bridge-managed worker:

```typescript
intercom_ask({
  to: "codex-worker",
  message: "Please inspect the failing test and reply with the most likely cause."
})
```

## Boundaries

- Do not assume push delivery into Codex. Check `intercom_pending`.
- Do not assume a normal MCP session can wake itself from idle. Use the
  app-server bridge for wake-on-message virtual workers.
- Do not use `intercom_ask` for passive polling of files, ports, or process
  completion. Use normal shell checks for those.
- Keep messages concise and include file paths, command output summaries, and
  decision options when useful.
