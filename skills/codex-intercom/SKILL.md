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
- `intercom_team({ team? })`: inspect one task team or list all memberships; falls back to managed-team discovery.
- `intercom_join({ name?, create?, members?, work? })`: list, join, or create an additive task team; the manager adds connected peers in one call.
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
3. When the user delegates to named peers and this task has no approved team, ask once whether to form a team with you and those peers. Wait for approval. An explicit create/join request is approval; never ask again for an approved task or inbound team message. After approval, discover peers and call `intercom_join({ name: "billing", create: true, members: ["front", "writer"], work: "Current task" })`. Do not ask the user to join each terminal manually. Reuse the approved team for the same task; new tasks may need new teams. Joining preserves all previous memberships and each team's manager/member roles.
4. Use `intercom_send` for non-blocking updates and handoffs. Include `team` for task messages, especially when multiple teams are shared. Without a shared team, omit `team` for initial ungrouped contact; unrelated memberships do not block contact or silently create teams.
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

Replies inherit the original message's team, never a mutable current team. Prefer `askId` or `contextId` returned by `intercom_pending` (contextId also selects ordinary messages). Mixed-team pending contexts require explicit selection; `team` cannot override the original. Within one task, `to` plus `oldest`/`latest` also selects an ask:

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
