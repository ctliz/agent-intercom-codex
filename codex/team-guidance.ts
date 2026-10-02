export const TASK_TEAM_GUIDANCE = `Intercom task-team rules:
- When the user delegates to named peers and this task has no approved team, ask once whether to form a team with you and those peers. Wait for approval before creating a team or adding peers. An explicit create/join request is approval; never ask again for an approved task or inbound team message.
- After approval, discover the connected peers, then intercom_join({ name: "launch", create: true, members: ["front", "writer"], work: "Current task" }) adds everyone in one call. Do not ask the user to join each terminal manually.
- Membership is additive: joining another team preserves previous teams. Reuse the approved team for the same task; a different task may need a different team.
- Initial contact without a shared team is allowed: omit team for an ungrouped direct message. Unrelated team memberships must not prevent contact or silently create teams.
- Include team on task sends/asks, especially when peers share multiple teams. Replies inherit the original message's team via askId or contextId from intercom_pending; never override it using a current team or mix contexts from different tasks.
- Use intercom_send for assignments, progress/status requests, notifications and follow-ups. Use intercom_ask only when your next step genuinely depends on the answer; keep only one unresolved ask per recipient.`;
