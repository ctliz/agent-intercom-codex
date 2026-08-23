# Changelog

## 0.12.0-connect.2 - 2026-08-23

- Add complete OpenAI MCP tool annotations for all nine Intercom tools.
- Cover every MCP tool by name and verify the exact annotation semantics in tests.
- Explicitly disable shell execution for production child-process launches while keeping arguments separated.

## 0.11.0-connect.1 - 2026-08-14

- Support Protocol v4 broker-enforced scope isolation (`AGENT_INTERCOM_SCOPE_ID`) and canonical `ctliz` distribution.
- Pin Core dependency to canonical commit `aad1985e125516b318181560293145bf2507cc6d` (`v0.1.0-connect.1`).
- Reject competing live runtimes that claim an active stable session ID while preserving legitimate reconnects and pending deliveries.
- Add ID-free `oldest`/`latest` selection for multiple pending asks from one sender, hide protocol IDs from pending output, and refuse a second unresolved ask to the same recipient.
- Automatically reconnect persistent bridges and MCP runtimes with their stable Intercom identity after broker restarts.
- Clarify that assignments and progress/status checkpoints use `intercom_send`, reserving `intercom_ask` for blocking decisions.
- Keep `coi` alive when Codex app-server emits retryable `error` notifications, and honor orchestrator fresh starts by discarding persisted bridge thread state.

## 0.10.0 - 2026-07-16

- Add `intercom_team` to the MCP and app-server bridge surfaces so owned Codex coworkers can find their manager and live siblings without a global peer search.
- Forward orchestrator worker identity into Codex's MCP subprocess so team discovery resolves the owned worker instead of the helper session.

## 0.9.3 - 2026-07-15

- Coordinate the Agent Intercom family on the `0.9.3` release line.

## 0.9.2 - 2026-07-14

- Coordinate the Agent Intercom family on the `0.9.2` release line.
- Declare canonical GitHub repository metadata for npm provenance verification.

- Add CI for branches and pull requests.
- Add tag-driven npm trusted publishing with provenance and automatic GitHub Releases.

## 0.9.1 - 2026-07-14

- Publish the package under the public npm scope `@dataforxyz/agent-intercom-codex`.
- Keep the Git repository and executable names unchanged.

## 0.9.0 - 2026-07-14

- Align the Agent Intercom family on one coordinated `0.9.0` release line.
- No behavior change from the immediately preceding AGPL release.

## 0.3.0 - 2026-07-14

### Changed
- Changed the current project license to `AGPL-3.0-or-later`. Previously published MIT versions remain under MIT, and original `pi-intercom` notices are preserved in `THIRD_PARTY_NOTICES.md`.

### Added
- Added protocol v3 delivery acknowledgements, explicit ask-control
  confirmations, and a durable sender outbox that replays safely after broker
  reconnects.
- Added an `Alt+I` shortcut to `coi` that copies the current session's usable
  intercom contact target.
- Added terminal-protocol, OSC 52, editor insertion, and stable-ID fallbacks for
  the shortcut, plus an opt-out flag for environments that do not want PTY
  interception.

### Changed
- Upgraded the bundled broker and client to the strict `pi-intercom` protocol
  v3 and automatically replace an incompatible older local broker.
- Ask timeouts now defer the ask, preserving late replies without holding the
  reverse-ask edge blocked indefinitely. Explicit cancellation still closes it.
- Made `node-pty` optional and clipboard helper execution asynchronous.

## [0.1.0] - 2026-07-03

### Added
- Added Codex MCP stdio server for local intercom messaging.
- Added tools for identity, status, session listing, summary updates, send,
  ask, pending, and reply.
- Added Codex plugin metadata and a `codex-intercom` skill.
- Vendored the minimal pi-intercom broker/client protocol for compatibility.
- Added an app-server bridge daemon that publishes virtual Codex workers as
  intercom sessions and wakes app-server turns on inbound messages.
- Added bridge config/state helpers and a `npm run codex:bridge` script.

### Fixed
- Shut down the MCP server when stdio closes so completed Codex runs do not
  leave stale intercom sessions behind.
- Defaulted bridge app-server launch to direct `codex app-server` mode so it
  works without the standalone managed daemon install.

### Docs
- Documented Codex MCP environment-variable behavior and the recommended
  `intercom_set_summary` discovery flow for ad hoc multi-Codex runs.
- Documented bridge configuration, security defaults, and managed daemon proxy
  mode.
