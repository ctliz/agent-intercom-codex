# Codex Intercom

<p>
  <img src="./assets/logo.svg" alt="Codex Intercom SVG logo" width="96" height="96">
  <img src="./assets/logo-generated.png" alt="Codex Intercom generated PNG logo" width="96" height="96">
</p>

**Agent Intercom** is a cross-harness, same-machine messaging system for coding agents. Its Pi, Codex, Claude Code, OpenCode, Grok Build, and AGY adapters share one local broker and protocol, so sessions can discover and message each other regardless of which harness they run in.

| Harness | Repository |
|---|---|
| Core / Protocol | [`agent-intercom-core`](https://github.com/ctliz/agent-intercom-core) |
| Pi | [`agent-intercom-pi`](https://github.com/ctliz/agent-intercom-pi) |
| Codex | [`agent-intercom-codex`](https://github.com/ctliz/agent-intercom-codex) |
| Claude Code | [`agent-intercom-claude`](https://github.com/ctliz/agent-intercom-claude) |
| OpenCode | [`agent-intercom-opencode`](https://github.com/ctliz/agent-intercom-opencode) |
| Grok Build | [`agent-intercom-grok`](https://github.com/ctliz/agent-intercom-grok) |
| AGY | [`agent-intercom-agy`](https://github.com/ctliz/agent-intercom-agy) |
| Fleet lifecycle | [`agent-intercom-orchestrator`](https://github.com/ctliz/agent-intercom-orchestrator) |

## Grok Build and AGY support

Grok Build and AGY are supported as first-class protocol peers through two dedicated npm packages:

| Host | npm package | Installed MCP launcher |
|---|---|---|
| Grok Build | [`@ctliz/agent-intercom-grok`](https://www.npmjs.com/package/@ctliz/agent-intercom-grok) | `agent-intercom-grok-mcp` |
| AGY | [`@ctliz/agent-intercom-agy`](https://www.npmjs.com/package/@ctliz/agent-intercom-agy) | `agent-intercom-agy-mcp` |

The host packages depend on `@ctliz/agent-intercom-claude` and load its MCP runtime internally. Users do **not** need to install or place `claude-intercom-mcp` on `PATH` separately. Once connected, Grok and AGY sessions share the same local broker and protocol as Pi, Codex, Claude Code, and OpenCode, and expose all nine MCP operations: `intercom_whoami`, `intercom_list`, `intercom_send`, `intercom_ask`, `intercom_reply`, `intercom_pending`, `intercom_status`, `intercom_team`, and `intercom_set_summary`.

Install the host adapter before installing its plugin:

```bash
npm install -g @ctliz/agent-intercom-grok
npm install -g @ctliz/agent-intercom-agy
```

For multi-pane or Auto-Team-style use, the supervisor must give every MCP child a unique literal identity and the same scope as its intended peers:

```text
AGENT_INTERCOM_SESSION_ID=<unique-pane-or-worker-id>
AGENT_INTERCOM_SESSION_NAME=<human-readable-name>
AGENT_INTERCOM_SCOPE_ID=<shared-team-or-workspace-scope>
```

The plugin manifests intentionally do not contain static session IDs, because sharing one ID across concurrent panes would create identity collisions. `CLAUDE_INTERCOM_SESSION_ID` and `CLAUDE_INTERCOM_NAME` remain higher-priority compatibility aliases.

Grok Build and AGY currently provide polling-only MCP integrations. Messages are durably retained, but there is no host-specific wake bridge to inject a new turn. Each active agent should call `intercom_pending` at startup and at natural work boundaries. They can join an existing team and exchange messages with every other adapter, but Agent Intercom Orchestrator does not currently spawn or lifecycle-manage Grok or AGY workers.

## Maintenance & Upstream Provenance

- **Maintained by `ctliz`**: This distribution is maintained independently by [ctliz](https://github.com/ctliz).
- **Upstream Heritage**: Agent Intercom grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom) and the upstream [`dataforxyz/agent-intercom-*`](https://github.com/dataforxyz/agent-intercom-codex) repositories. This project is not officially endorsed by or affiliated with upstream organizations.
- **Package Namespace**: The canonical npm namespace is `@ctliz/*`. The historical `@dataforxyz/*` namespace was used up to and including `connect.1` and is retained only as provenance and as a migration-detection input; it is never treated as a current or healthy installation. The **Agent Intercom** branding and the `intercom_*` API surface are unchanged.

## Protocol v4 & Broker-Enforced Scope

Agent Intercom protocol v4 introduces **broker-enforced scope routing** via `AGENT_INTERCOM_SCOPE_ID`:

- **Registration**: The client submits its `scopeId` once in the top-level registration payload.
- **Broker Enforcement**: The shared local broker stores the scope in its private `ConnectedSession` record and enforces same-scope discovery (`intercom_list`), naming, and prefix matching.
- **Cross-Scope Routing**: Cross-scope messaging is fail-closed; communication across different scopes is permitted only when addressing an explicit full session ID.
- **UX Routing Isolation**: Scope is designed for same-OS-user workflow isolation (e.g. per-project or per-workspace agent teams), **not** as a cryptographic security principal, tenant boundary, or authentication credential.
- **Leak-Free**: The raw `scopeId` value never enters `SessionInfo`, list payloads, lifecycle events, frontend displays, or execution logs.
- **Standalone First**: `AGENT_INTERCOM_SCOPE_ID` is a general shell/IDE/service launcher contract. Agent Intercom works completely standalone in any terminal, tmux window, or script; TmuxDeck is optional visual tooling.

## Origin and thanks

Agent Intercom grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). A sincere thank you to Nico and the original contributors for creating the Pi extension and the foundation this cross-harness family builds on.

This repository contains the Codex adapter. It gives Codex sessions native intercom tools and wakeable workers while remaining fully interoperable with the other Agent Intercom harnesses.

The bundled client and broker use strict intercom protocol v4. A send is only
reported as delivered after the receiving adapter acknowledges it. Unfinished
outbound sends are persisted under the shared intercom runtime directory and
replayed with their original IDs after reconnect, making retries safe with
receiver deduplication. Incompatible older local brokers fail closed without
killing, downgrading, or creating second islands.

The project has two related pieces:

- `codex-intercom-mcp`: an MCP server that exposes intercom tools inside a
  normal Codex session.
- `coi`: a wakeable Codex sidecar launcher. It starts a Codex app-server,
  registers an intercom identity, and starts Codex turns when another session
  sends it work.

Use plain MCP when you only need tools inside an already-active Codex turn. Use
`coi` when you want another session to wake the worker automatically or when
you want the host-level **Alt+I** and **Alt+M** shortcuts. Codex's MCP interface can
provide intercom tools, but it cannot add custom keybindings to the Codex TUI.

## Status

Preview. This is the Codex adapter in the cross-harness Agent Intercom family.

Plain Codex MCP sessions do not receive Pi-style unsolicited visible turns.
Incoming messages are queued while the MCP server is running; call
`intercom_pending` to read them. Wake-on-message workflows require `coi` or the
app-server bridge.

When an external intercom turn completes, `coi` refreshes the attached remote
TUI by resuming the same thread. The inbound message and final response then
appear in the already-open terminal instead of existing only in the saved
transcript. This refresh happens after the turn is idle so Codex does not reopen
in a phantom `Working` state. Retryable app-server stream errors are reported as reconnecting without terminating the sidecar, allowing Codex's own retry to complete. Orchestrated `fresh: true` launches remove the saved `coi` thread state before registration.

The additive Stage-B `boss-run-v1` adapter contracts are present but dormant.
Ordinary local and remote-access communication continues to use the existing
protocol-v4 behavior when Boss metadata is omitted. The legacy broker does not
advertise or bind Boss participants until a protected provider supplies all of
the required broker identity, credential-registry, authority-transition, and
participant-health predicates. Boss-scoped discovery and routing fail closed
across ordinary sessions and other Boss runs. The `boss_participant` and
`boss_reviewer` launch-profile markers make production Codex launches fail
with `PROVIDER_AUTHORITY_UNAVAILABLE`: this adapter has no broker-owned,
artifact-attested provider executable and therefore never resolves protected
launches through caller `PATH`. Their non-spawning parser validators still
reject disabled approvals and `danger-full-access`, and reviewers remain
read-only. The markers do not install or advertise a restricted operation client.
Restricted Boss operation clients are not advertised or exported yet. They
remain unavailable until the protected broker can provision both the binding
and transport through a non-caller-forgeable factory.

## Install

For normal use, install the package so the command-line entry points are on
`PATH`:

```bash
npm install -g @ctliz/agent-intercom-codex@connect
# or by exact prerelease version
npm install -g @ctliz/agent-intercom-codex@0.12.0-connect.7
```

This provides:

- `codex-intercom-mcp`
- `codex-intercom-bridge`
- `coi`

Then add the MCP server to Codex:

```bash
codex mcp add codex-intercom -- codex-intercom-mcp
```

Optional MCP identity variables can be attached at registration time:

```bash
codex mcp add codex-planner \
  --env CODEX_INTERCOM_NAME=planner \
  --env CODEX_INTERCOM_SESSION_ID=codex-planner \
  --env CODEX_INTERCOM_MODEL=codex \
  -- codex-intercom-mcp
```

Per-command environment variables passed to `codex exec` are not forwarded into
the MCP server process. Configure identity on the MCP server entry when you need
stable names or IDs.

To let a Pi manager create Codex workers with owned systemd cgroups, leases, model/effort selection, logs, and verified cleanup, install the companion Pi packages:

```bash
pi install git:github.com/ctliz/agent-intercom-pi@v0.12.0-connect.8
pi install git:github.com/ctliz/agent-intercom-orchestrator@v0.12.0-connect.5
```

Restart Pi or run `/reload`, then call `agent_fleet({ action: "doctor" })`. The orchestrator invokes the installed `coi` command, or a separately configured minimal wrapper such as `coim`; it does not replace this Codex adapter.

## Plugin Use

This repo also includes Codex plugin metadata:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/codex-intercom/SKILL.md`

The plugin packages the MCP server and the optional intercom skill. It is useful
when you want Codex to install and manage the intercom integration as a plugin.
For a deliberately minimal profile, prefer direct MCP configuration with
`codex-intercom-mcp`; that lets you disable plugins and skills while keeping the
intercom tools.

## Tools

- `intercom_whoami`: show this session's intercom ID, name, cwd, and model.
- `intercom_team`: show the current manager and live coworkers owned by that manager.
- `intercom_status`: show connection status and pending message counts.
- `intercom_list`: list local Pi, Codex, Claude Code, and OpenCode sessions in your scope (protocol v4 is same-scope; cross-scope contact requires an exact full session ID).
- `intercom_set_summary`: publish a short discoverable status.
- `intercom_send`: send a non-blocking message.
- `intercom_ask`: send a question and wait for the target's reply.
- `intercom_pending`: read queued inbound messages and unresolved asks.
- `intercom_reply`: reply to a pending inbound ask; use `to` plus `which: "oldest" | "latest"` if one sender has multiple unresolved asks.

Pending output never exposes protocol message IDs. Keep at most one unresolved `intercom_ask` to the same recipient; the broker rejects a second ask and recommends `intercom_send` for a non-blocking follow-up. Use `intercom_send`—not `intercom_ask`—for assignments and progress/status checkpoints.

Persistent Codex bridges and plain MCP runtimes automatically reconnect their stable Intercom identity after a broker restart, so a live worker does not need to be respawned merely to become reachable again.

Example:

```typescript
intercom_team({})
// Manager: manager-id [connected]
// You: worker-a
// Coworkers: reviewer target=reviewer (claude, challenger, running) [connected]

intercom_ask({
  to: "worker-a",
  message: "Please inspect the failing test and reply with the likely cause.",
  timeout_ms: 45000
})
```

Blocking asks default to a short bounded wait and reject waits over 120 seconds.
For longer work, use `intercom_send` and check later with `intercom_pending`.

## Wakeable Workers With `coi`

`coi` starts a per-agent Codex app-server socket, registers an intercom sidecar
for that socket, creates or resumes the sidecar's app-server thread, then
launches an interactive Codex UI attached to the same socket and thread.

Start a named worker:

```bash
coi --name worker-a --id worker-a
```

If you launch wakeable workers often, a shell alias keeps `coi` distinct from a
plain `codex` session:

```bash
alias codex-intercom='coi'
```

Then run `codex-intercom --name worker-a --id worker-a`. The alias is optional;
the important part is launching through `coi`, because the wrapper owns the
app-server sidecar that wakes on incoming work and the terminal integration
that provides **Alt+I** and **Alt+M**. Starting `codex` directly with only the MCP server
still provides intercom tools, but not those host-level behaviors.

Useful flags:

```bash
coi --name api-worker --id api-worker
coi --cwd /path/to/project --instructions "Reply tersely. Ask before destructive changes."
coi --no-tui --name background-worker --id background-worker
```

Everything not recognized as a sidecar flag is passed through to
`codex resume --remote`, so normal Codex flags still work. Prompt arguments are
placed after the resumed sidecar thread ID.

While the `coi` TUI is open, press **Alt+I** to copy a short handoff snippet for
the current intercom session. As in `pi-intercom`, the snippet uses the unique
session name when possible and falls back to the stable intercom session ID.
The shortcut is provided by the `coi` launcher; plain MCP-only Codex sessions do
not have a plugin API for custom TUI actions.

Press **Alt+M** to insert the Codex intercom session-picker request. Codex will
call `intercom_list`, show the available sessions, ask which peer and message
you want, then use `intercom_send`. Codex does not expose native slash-command
or overlay registration, so `coi` provides this assisted flow instead of
claiming a native `/intercom` command. The equivalent MCP tools remain
available directly in every Codex session.

| Action | Codex surface |
|---|---|
| Choose a session and send | **Alt+M** in `coi` |
| Copy this session's contact target | **Alt+I** in `coi` |
| Find an orchestrator-owned manager or coworker | `intercom_team` |
| Script or ask directly | `intercom_list`, `intercom_send`, `intercom_ask` |

The shortcut uses native clipboard helpers locally and OSC 52 for SSH sessions.
If clipboard access fails, `coi` inserts the snippet into the Codex composer.
Disable the PTY-backed shortcut with `--no-intercom-shortcut` or
`CODEX_INTERCOM_SHORTCUT=0`. The optional `node-pty` dependency is only loaded
when the shortcut is enabled in an interactive terminal; if it is unavailable,
`coi` launches the normal Codex TUI without the shortcut.

`coi` also applies Codex runtime flags such as `--sandbox`,
`--ask-for-approval`, and `--add-dir` to wake-triggered sidecar turns. For
example, `coi --name worker-a --id worker-a --sandbox workspace-write` lets
intercom-woken turns write inside the worker workspace instead of falling back
to read-only.

The sidecar inherits `CODEX_HOME`, which makes it useful with a normal Codex
home or a dedicated minimal home.

Every packaged executable writes one machine-searchable identity line to stderr
before application startup:

```text
[agent-intercom-build] package=@ctliz/agent-intercom-codex version=0.11.0-connect.2 target=coi sourceSha256=<64-hex-source-identity>
```

`dist/build-info.json` records the same deterministic runtime-source identity.
Use the line from the actual process journal—not the current file path or
mtime—to prove which bundle a remote worker loaded. Test-only changes do not
alter the identity; any runtime, build-script, package, or pinned-dependency
change does.

## Minimal Wakeable Profile

A minimal profile is useful for workers that should stay focused on code and
coordination. It reduces prompt/tool surface area by isolating the worker from
your normal Codex config, memories, plugins, browser surfaces, image generation,
and extra skills. Keep goals and multi-agent support on so the worker can track
the task and delegate subtasks.

Create a dedicated Codex home:

```bash
export CODEX_MIN_HOME="$HOME/.codex-min-intercom"
mkdir -p "$CODEX_MIN_HOME"
```

`$CODEX_MIN_HOME/config.toml`:

```toml
model = "gpt-5.5"
web_search = "disabled"

[features]
apps = false
memories = false
web_search = false
web_search_cached = false
web_search_request = false

# Keep the core coding-agent surface.
goals = true
multi_agent = true
shell_tool = true
unified_exec = true
auto_compaction = true
tool_call_mcp_elicitation = true

# Disable optional/distraction-heavy surfaces.
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
in_app_browser = false
computer_use = false
image_generation = false
plugins = false
plugin_sharing = false
tool_suggest = false
skill_mcp_dependency_install = false
hooks = false
workspace_dependencies = false

[mcp_servers.codex-intercom]
command = "codex-intercom-mcp"
```

After the first launch, Codex may populate system skills under the alternate
home. To keep the profile minimal without deleting anything, list the skill
paths:

```bash
find "$CODEX_MIN_HOME/skills" -name SKILL.md -print
```

For each skill you want disabled, add a config entry:

```toml
[[skills.config]]
path = "/absolute/path/from/find/SKILL.md"
enabled = false
```

There is no required alias name. A short alias such as `cim` keeps the minimal
worker easy to launch:

```bash
cim() {
  local home="${CODEX_MIN_HOME:-$HOME/.codex-min-intercom}"
  local yolo="${CODEX_YOLO:-1}"
  case "${1:-}" in
    yolo|--yolo|on) shift; yolo=1 ;;
    safe|--safe|off) shift; yolo=0 ;;
  esac
  local args=(--name codex-min)
  [ "$yolo" = 1 ] && args+=(--dangerously-bypass-approvals-and-sandbox)
  CODEX_HOME="$home" coi "${args[@]}" "$@"
}
```

This alias intentionally defaults the minimal worker to yolo mode: no approval
prompts and no filesystem sandbox. Use it only for workers you trust with the
current machine account, or remove the bypass flag when you want a safer
workspace-scoped worker. Use `cim safe ...` or set `CODEX_YOLO=0` to launch
without the bypass flag.

Use it like:

```bash
cim --name worker-a --id worker-a
cim --name reviewer --id reviewer --instructions "Review only; do not edit files."
cim --no-tui --name background-worker --id background-worker
cim safe --name safe-worker --id safe-worker --sandbox workspace-write
```

If you are developing this repository from a checkout instead of installing the
package, build and link it:

```bash
npm install
npm run build
npm link
```

Or point an alias directly at the checkout:

```bash
cim() {
  local home="${CODEX_MIN_HOME:-$HOME/.codex-min-intercom}"
  local repo="${CODEX_INTERCOM_REPO:-/absolute/path/to/agent-intercom-codex}"
  local yolo="${CODEX_YOLO:-1}"
  case "${1:-}" in
    yolo|--yolo|on) shift; yolo=1 ;;
    safe|--safe|off) shift; yolo=0 ;;
  esac
  local args=(--name codex-min)
  [ "$yolo" = 1 ] && args+=(--dangerously-bypass-approvals-and-sandbox)
  CODEX_HOME="$home" node "$repo/dist/coi.mjs" "${args[@]}" "$@"
}
```

## Manager And Worker Pattern

Use one Codex session as the manager and one or more `coi` sessions as wakeable
workers. The manager keeps the task shaped, feeds work to workers, watches for
drift, and decides when the work is ready to finish.

Example worker launch in `tmux`:

```bash
tmux new-session -d -s worker-a 'cd /path/to/project && cim --name worker-a --id worker-a'
```

Then ask the worker from the manager session:

```typescript
intercom_ask({
  to: "worker-a",
  message: "Please create a goal for the task, inspect the handoff, and report your first plan.",
  timeout_ms: 45000
})
```

Recommended manager prompt:

```text
Start a wakeable worker in tmux using the minimal intercom alias:

  tmux new-session -d -s <worker-id> 'cd <repo> && cim --name <worker-id> --id <worker-id>'

Give the worker a FEAT.md-style handoff:

# FEAT: <short task name>
Objective: <what must be true when done>
Context: <repo, branch, issue, constraints, important files>
Approach: <suggested first steps, but allow the worker to adjust>
Verification: <commands/tests/checks that should pass>
Definition of done: <clear finish criteria>
Coordination: create a goal, use subagents when useful, keep the manager updated through intercom, ask before risky or broad changes, and keep work in a branch/worktree when appropriate.

Tell the worker to create and maintain its own goal, use agents for parallel investigation or review, and report blockers early. As manager, keep sending focused follow-up work through intercom, keep the worker on task, and handle PR or final handoff when the implementation is ready.
```

For non-blocking delegation, use `intercom_send` and check back later. For a
decision the manager needs before continuing, use `intercom_ask`.

## App-Server Bridge

Use `codex-intercom-bridge` when you want one process to publish one or more
configured virtual Codex workers without launching an interactive TUI for each
worker.

Create a bridge config:

```json
{
  "statePath": "/path/to/intercom/codex-bridge-state.json",
  "agents": [
    {
      "id": "codex-worker",
      "name": "codex-worker",
      "cwd": "/path/to/project",
      "model": "gpt-5.5",
      "instructions": "Reply concisely. Ask before making destructive changes."
    }
  ]
}
```

Start it:

```bash
codex-intercom-bridge --config "$HOME/.config/codex-intercom/bridge.json"
```

Then other local sessions can target `codex-worker` with `intercom_send` or
`intercom_ask`. The bridge stores each worker's app-server `threadId` in
`statePath`, so later messages continue the same Codex thread.

By default, bridge turns run with `approvalPolicy: "never"` and read-only,
network-disabled sandboxing. Override `approvalPolicy` or `sandboxPolicy` in
the agent config only when you explicitly want a background worker to have more
authority.

## Development

Clone and run from source:

```bash
git clone https://github.com/ctliz/agent-intercom-codex.git
cd agent-intercom-codex
npm install
npm run build
npm test
```

For MCP development, register the TypeScript source directly:

```bash
codex mcp add codex-intercom-dev -- npx --no-install tsx ./codex/server.ts
```

Use either the built install or the dev install in a given Codex profile.
Running both at the same time can register duplicate intercom MCP tools.

## Agent Intercom Compatibility

`agent-intercom-pi` is the Pi-native adapter with overlays, inline rendering,
and Pi `triggerTurn` delivery. This repository, `agent-intercom-codex`, is the
Codex MCP/plugin adapter plus wake-on-message Codex app-server sidecars. The
Claude Code and OpenCode adapters join the same broker and appear in the same
session list.

All four repositories vendor the compatible local broker/client protocol so any
adapter can start the broker and communicate across harness boundaries.

## Releasing

Releases are automated from version tags. Update `package.json`, the lockfile when
present, and `CHANGELOG.md` on `main`, then push an annotated tag that exactly
matches the package version:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The release workflow verifies that the tag points into `main`, runs typecheck,
tests, and the build, publishes the public npm package with trusted OIDC
provenance, and creates the GitHub Release. Existing npm versions and GitHub
Releases are skipped safely when a workflow is rerun.

## Compatibility, Migration & Rollback

- **Single Shared Broker**: The broker-capable adapters on the machine — `pi`, `claude`, `codex`, and `opencode` — connect to one local broker over a Unix domain socket (`~/.pi/agent/intercom/broker.sock` or `$PI_CODING_AGENT_DIR/intercom/broker.sock`).
- **Coordinated Upgrade Set**: Protocol v4 changes broker negotiation, so the broker-capable adapters that are *actually installed and enabled on this machine* must be upgraded together in one maintenance window. Adapters you do not use do not need to be installed to satisfy the upgrade. `@ctliz/agent-intercom-core` is an internal dependency that arrives with the adapters and is never installed or upgraded on its own.
- **Orchestrator is Optional**: `agent-intercom-orchestrator` is an optional Linux/systemd lifecycle component. It does not implement or start a Broker and is not part of the Broker compatibility set. Omitting it — for example on macOS, or when using TmuxDeck — is a fully supported configuration and is **not** a mixed or unsupported state. If it is installed on a supported Linux host, or on WSL with a systemd user manager enabled, update it together with the adapters it manages.
- **Fail-Closed Legacy Handling**: An incompatible legacy (v3) broker or client fails closed. It is rejected at negotiation and never killed, never downgraded, and never allowed to form a second broker island.
- **Rollback**: Rolling back covers only the components that were actually installed on this machine before the upgrade. Restore the exact specs and lockfiles you backed up, then reload the affected agent sessions. Roll Orchestrator back only if it was installed to begin with. There is no published pre-v4 tag under `ctliz`, so a pre-upgrade backup of the exact installed specs/locks is the supported rollback material. Leaving some installed broker-capable adapters on the old protocol while others are upgraded is an unsupported mixed state.

## License

The current project is licensed under the [GNU Affero General Public License
v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). If you modify this software and
make the modified version available to users over a network, the AGPL requires
you to offer those users the corresponding source code.

Portions derived from the original MIT-licensed `pi-intercom` project retain
their original notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[licenses/MIT-pi-intercom.txt](licenses/MIT-pi-intercom.txt). Versions already
published under MIT remain available under their original terms. See
[LICENSE_TRANSITION.md](LICENSE_TRANSITION.md) for the exact commit and tag boundary.

## Upgrading from `connect.1` to `connect.2`

`connect.2` renames the package namespace from `@dataforxyz/*` to `@ctliz/*`. The two namespaces are different packages to npm. Pi Git package installations deduplicate by repository URL without ref, but running agent sessions continue to execute legacy code in memory, and npm or global installs along with binary links can coexist and conflict. Operators must stop active sessions, clean active install surfaces, and follow remove-before-install — side-by-side installation is not supported.

1. Back up the exact specs, lock files, and settings of every installed component.
2. Stop or close the installed broker-capable adapters.
3. Remove the old `@dataforxyz/*` specs, packages, and binary links that are actually installed.
4. Assert the old identity is gone from the **active install surfaces of the current OS user**: Pi settings and extension specs, resolved managed install roots, actual `node_modules` installations, and conflicting binary links that the current `PATH` would resolve. Do not scan or delete unrelated source checkouts, historical documentation, or other users' files — a `@dataforxyz/*` string in an unrelated development clone is not an installation.
5. Install the `@ctliz/*` `connect.2` exact tags for the components you actually use (v0.11.0-connect.2).
6. Reload or restart, then verify exactly one broker is running.

**Classification rule.** Migration-aware `connect.2` setup and update tooling must classify an old-namespace-only install surface as `MIGRATION_REQUIRED`, and the simultaneous presence of both namespaces as a duplicate/dual-load hard error that refuses setup, update, and further installation. This tooling does not exist for every platform and adapter combination; where it is not available, apply the same two rules manually against the surfaces in step 4. Do not assume every adapter emits this code automatically.

**Rollback** reverses this and covers only the components that were installed on this machine before the upgrade: remove the `@ctliz/*` packages, then restore the backed-up exact `@dataforxyz/*` specs and locks. Roll Orchestrator back only if it was installed to begin with.

The `connect.1` tags, source commits, and published release assets are immutable and are not modified by this migration. Release notes may carry an explicit erratum, which corrects the description only and never moves a tag or replaces an asset.

These packages are not published on the npm registry yet; install from the GitHub tags shown above.
