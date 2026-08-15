import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatIntercomTeam, resolveIntercomTeam, resolveManagedInboxSession, type TeamSession } from "./team.ts";

const legacyWorker = (id: string, runId: string, managerSessionId: string, state = "running") => ({
  id, runId, harness: "codex", role: "reviewer", state, owned: true, managerSessionId, intercomTarget: id,
});

const bossWorker = (
  id: string,
  bossRunId: string,
  participantId: string,
  role: "manager" | "worker" = "worker",
  intercomTarget = id,
) => ({
  id,
  workerIncarnationId: `incarnation-${id}`,
  workerGeneration: 1,
  bossRunId,
  participantId,
  bindingEpoch: 1,
  harness: "codex",
  role,
  state: "working",
  owned: true,
  managerSessionId: "manager-session",
  intercomTarget,
});

function bossSession(worker: ReturnType<typeof bossWorker>): TeamSession {
  return {
    id: worker.intercomTarget,
    boss: {
      binding: {
        bossRunId: worker.bossRunId,
        participantId: worker.participantId,
        bindingEpoch: worker.bindingEpoch,
        role: worker.role,
        sessionId: worker.intercomTarget,
        state: "active",
      },
      workerIdentity: {
        version: "orc.worker-identity.v2",
        workerId: worker.id,
        workerIncarnationId: worker.workerIncarnationId,
        workerGeneration: worker.workerGeneration,
        bossRunId: worker.bossRunId,
        participantId: worker.participantId,
        bindingEpoch: worker.bindingEpoch,
      },
      participantState: worker.state,
    },
  };
}

const bossEnv = {
  AGENT_INTERCOM_WORKER_ID: "self",
  AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-self",
  AGENT_INTERCOM_WORKER_GENERATION: "1",
  AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
  AGENT_INTERCOM_PARTICIPANT_ID: "participant-self",
  AGENT_INTERCOM_BINDING_EPOCH: "1",
};

test("ordinary team discovery follows the orchestrator owner instead of stale worker environment", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      version: 1,
      workers: [legacyWorker("self", "run-self", "manager-new"), legacyWorker("peer", "run-peer", "manager-new"), legacyWorker("old", "run-old", "manager-old")],
    }));
    const team = await resolveIntercomTeam({
      selfId: "mcp-helper",
      agentDir,
      env: { AGENT_INTERCOM_WORKER_ID: "self", AGENT_INTERCOM_RUN_ID: "run-self", AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-old" },
      sessions: [{ id: "manager-new" }, { id: "peer" }],
    });
    assert.equal(team.manager?.target, "manager-new");
    assert.equal(team.manager?.connected, true);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
    assert.match(formatIntercomTeam(team), /You: self/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Boss roster intersects exact session/run/participant/epoch/role/incarnation/generation/state", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const self = bossWorker("self", "boss-run-1", "participant-self", "worker", "self-session");
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const peer = bossWorker("same-run", "boss-run-1", "participant-peer");
    const hidden = bossWorker("hidden-same-run", "boss-run-1", "participant-hidden");
    const other = bossWorker("other-run", "boss-run-2", "participant-other");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [self, manager, peer, hidden, other] }));
    const team = await resolveIntercomTeam({
      selfId: "self-session",
      agentDir,
      env: bossEnv,
      sessions: [bossSession(self), bossSession(manager), bossSession(peer), bossSession(other)],
    });
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager?.connected, true);
    assert.deepEqual(team.coworkers, [], "a Worker must not discover a sibling Worker");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a current-run Manager retains exact live visibility of its owned Workers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-manager-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const workerOne = bossWorker("worker-one", "boss-run-1", "participant-one");
    const workerTwo = bossWorker("worker-two", "boss-run-1", "participant-two");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, workerOne, workerTwo] }));
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "manager",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
        AGENT_INTERCOM_WORKER_GENERATION: "1",
        AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
        AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
        AGENT_INTERCOM_BINDING_EPOCH: "1",
      },
      sessions: [bossSession(manager), bossSession(workerOne), bossSession(workerTwo)],
    });
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["worker-one", "worker-two"]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a Boss Manager cannot discover a roster through a substituted selfId", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-substituted-self-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const worker = bossWorker("worker", "boss-run-1", "participant-worker", "worker", "worker-session");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, worker] }));
    const team = await resolveIntercomTeam({
      selfId: "worker-session",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "manager",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
        AGENT_INTERCOM_WORKER_GENERATION: "1",
        AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
        AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
        AGENT_INTERCOM_BINDING_EPOCH: "1",
      },
      sessions: [bossSession(manager), bossSession(worker)],
    });
    assert.equal(team.self.id, "worker-session");
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager, undefined);
    assert.deepEqual(team.coworkers, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("duplicate Boss current worker or live-session IDs fail closed", async () => {
  for (const duplicate of ["worker", "session"] as const) {
    const agentDir = await mkdtemp(join(tmpdir(), `codex-boss-duplicate-${duplicate}-`));
    const dir = join(agentDir, "intercom", "orchestrator");
    await mkdir(dir, { recursive: true });
    try {
      const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
      const worker = bossWorker("worker", "boss-run-1", "participant-worker");
      const staleDuplicate = { ...manager, workerGeneration: 2, intercomTarget: "stale-manager-session" };
      const workers = duplicate === "worker" ? [manager, staleDuplicate, worker] : [manager, worker];
      const sessions = duplicate === "session" ? [bossSession(manager), bossSession(manager), bossSession(worker)] : [bossSession(manager), bossSession(worker)];
      await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers }));
      const team = await resolveIntercomTeam({
        selfId: "manager-session",
        agentDir,
        env: {
          AGENT_INTERCOM_WORKER_ID: "manager",
          AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
          AGENT_INTERCOM_WORKER_GENERATION: "1",
          AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
          AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
          AGENT_INTERCOM_BINDING_EPOCH: "1",
        },
        sessions,
      });
      assert.equal(team.self.isManager, false, `${duplicate} duplication must not confer Manager discovery`);
      assert.equal(team.manager, undefined);
      assert.deepEqual(team.coworkers, []);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("a stale current Boss live binding cannot unlock Manager roster discovery", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-stale-binding-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const worker = bossWorker("worker", "boss-run-1", "participant-worker");
    const staleManagerSession = bossSession(manager);
    staleManagerSession.boss!.binding!.bindingEpoch = 2;
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, worker] }));
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "manager",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
        AGENT_INTERCOM_WORKER_GENERATION: "1",
        AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
        AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
        AGENT_INTERCOM_BINDING_EPOCH: "1",
      },
      sessions: [staleManagerSession, bossSession(worker)],
    });
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager, undefined);
    assert.deepEqual(team.coworkers, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a self-consistent foreign-run Manager is never projected as connected", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-foreign-manager-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const self = bossWorker("self", "boss-run-1", "participant-self", "worker", "self-session");
    const foreignManager = bossWorker("manager", "boss-run-2", "participant-manager", "manager", "manager-session");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [self, foreignManager] }));
    const team = await resolveIntercomTeam({
      selfId: "self-session",
      agentDir,
      env: bossEnv,
      sessions: [bossSession(self), bossSession(foreignManager)],
    });
    assert.deepEqual(team.manager, { target: "manager-session", connected: false });
    assert.deepEqual(team.coworkers, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("every substituted Boss roster identity dimension fails closed", async () => {
  const dimensions = [
    ["session", (session: TeamSession) => { session.id = "substituted-session"; session.name = "peer"; }],
    ["binding session", (session: TeamSession) => { session.boss!.binding!.sessionId = "substituted-session"; }],
    ["run", (session: TeamSession) => { session.boss!.binding!.bossRunId = "other-run"; }],
    ["participant", (session: TeamSession) => { session.boss!.binding!.participantId = "other-participant"; }],
    ["epoch", (session: TeamSession) => { session.boss!.binding!.bindingEpoch = 2; }],
    ["role", (session: TeamSession) => { session.boss!.binding!.role = "scout"; }],
    ["incarnation", (session: TeamSession) => { (session.boss!.workerIdentity as Record<string, unknown>).workerIncarnationId = "other-incarnation"; }],
    ["generation", (session: TeamSession) => { (session.boss!.workerIdentity as Record<string, unknown>).workerGeneration = 2; }],
    ["state", (session: TeamSession) => { session.boss!.participantState = "waiting"; }],
  ] as const;
  for (const [name, mutate] of dimensions) {
    const agentDir = await mkdtemp(join(tmpdir(), `codex-boss-team-${name.replaceAll(" ", "-")}-`));
    const dir = join(agentDir, "intercom", "orchestrator");
    await mkdir(dir, { recursive: true });
    try {
      const self = bossWorker("self", "boss-run-1", "participant-self", "worker", "self-session");
      const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
      const peer = bossWorker("peer", "boss-run-1", "participant-peer");
      await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [self, manager, peer] }));
      const peerSession = bossSession(peer);
      mutate(peerSession);
      const team = await resolveIntercomTeam({
        selfId: "self-session",
        agentDir,
        env: bossEnv,
        sessions: [bossSession(self), bossSession(manager), peerSession],
      });
      assert.deepEqual(team.coworkers, [], `${name} substitution must be hidden`);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("stale current Boss identity is not promoted to Manager", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-team-stale-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const self = { ...bossWorker("self", "boss-run-1", "participant-self", "worker", "self-session"), workerGeneration: 2 };
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [self] }));
    const team = await resolveIntercomTeam({ selfId: "self-session", agentDir, env: bossEnv, sessions: [bossSession(self)] });
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager, undefined);
    assert.deepEqual(team.coworkers, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("TmuxDeck manifest resolution correctly identifies Lead and Workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-manifest-"));
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
  }
  const manifestPath = join(dir, "team.json");
  const leadId = "tmuxdeck-11111111-1111-4111-8111-111111111111";
  const worker1 = "tmuxdeck-22222222-2222-4222-8222-222222222222";
  const worker2 = "tmuxdeck-33333333-3333-4333-8333-333333333333";
  const manifest = {
    version: "tmuxdeck.team.v1",
    backend: "tmuxdeck",
    runId: "team_44444444-4444-4444-8444-444444444444",
    leadId,
    members: [
      { sessionId: leadId, role: "lead" },
      { sessionId: worker1, role: "worker" },
      { sessionId: worker2, role: "worker" },
    ],
    createdAt: 1700000000000,
    capabilities: [],
  };
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(manifestPath, 0o600);
  }

  try {
    const sessions = [
      { id: leadId, model: "codex" },
      { id: worker1, model: "codex" },
      { id: worker2, model: "claude" },
    ];

    // 1. Worker 1 view
    const workerTeam = await resolveIntercomTeam({
      selfId: worker1,
      env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
      sessions,
    });
    assert.equal(workerTeam.source, "manifest");
    assert.equal(workerTeam.teamId, manifest.runId);
    assert.equal(workerTeam.self.isManager, false);
    assert.equal(workerTeam.manager?.target, leadId);
    assert.equal(workerTeam.manager?.connected, true);
    assert.deepEqual(workerTeam.coworkers.map((c) => c.id), [worker2]);

    // 2. Lead view
    const leadTeam = await resolveIntercomTeam({
      selfId: leadId,
      env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
      sessions,
    });
    assert.equal(leadTeam.source, "manifest");
    assert.equal(leadTeam.teamId, manifest.runId);
    assert.equal(leadTeam.self.isManager, true);
    assert.equal(leadTeam.manager?.target, leadId);
    assert.deepEqual(leadTeam.coworkers.map((c) => c.id), [worker1, worker2]);
    assert.match(formatIntercomTeam(leadTeam), new RegExp(`You: ${leadId} \\[manager\\]`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Invalid or unreadable TmuxDeck manifest fails closed without live fallback", async () => {
  // 1. Nonexistent manifest path
  await assert.rejects(
    async () => resolveIntercomTeam({
      selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
      env: {
        AGENT_INTERCOM_TEAM_MANIFEST: "/nonexistent/manifest.json",
        AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
      },
      sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }, { id: "tmuxdeck-22222222-2222-4222-8222-222222222222" }],
    }),
    /ERR_TEAM_MANIFEST_UNAVAILABLE/,
  );

  // 2. Malformed JSON manifest
  const dir = await mkdtemp(join(tmpdir(), "codex-bad-manifest-"));
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
  }
  const badJsonPath = join(dir, "bad.json");
  await writeFile(badJsonPath, "{ not valid json", { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(badJsonPath, 0o600);
  }
  try {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
        env: {
          AGENT_INTERCOM_TEAM_MANIFEST: badJsonPath,
          AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
        },
        sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 3. Empty or whitespace manifest env var throws ERR_TEAM_MANIFEST_INVALID
  for (const emptyVal of ["", "   ", "\t\n"]) {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
        env: {
          AGENT_INTERCOM_TEAM_MANIFEST: emptyVal,
          AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
        },
        sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  }

  // 4. Valid manifest JSON but self is not in members throws ERR_TEAM_MANIFEST_INVALID
  const validDir = await mkdtemp(join(tmpdir(), "codex-self-not-member-"));
  if (process.platform !== "win32") {
    await chmod(validDir, 0o700);
  }
  const notMemberPath = join(validDir, "manifest.json");
  await writeFile(
    notMemberPath,
    JSON.stringify({
      version: "tmuxdeck.team.v1",
      backend: "tmuxdeck",
      runId: "team_44444444-4444-4444-8444-444444444444",
      leadId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
      members: [{ sessionId: "tmuxdeck-11111111-1111-4111-8111-111111111111", role: "lead" }],
      createdAt: 1700000000000,
      capabilities: [],
    }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") {
    await chmod(notMemberPath, 0o600);
  }
  try {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-99999999-9999-4999-8999-999999999999",
        env: { AGENT_INTERCOM_TEAM_MANIFEST: notMemberPath },
        sessions: [{ id: "tmuxdeck-99999999-9999-4999-8999-999999999999" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  } finally {
    await rm(validDir, { recursive: true, force: true });
  }
});

test("Workspace live roster fallback discovers same-scope active non-human peers", async () => {
  const sessions: TeamSession[] = [
    { id: "lead-pane", model: "codex" },
    { id: "worker-pane", model: "codex" },
    { id: "me", model: "opencode" }, // valid agent named "me"
    { id: "human-user", model: "human" }, // exact "human" session to be excluded
    { id: "human-caps", model: "Human" }, // non-exact "Human" model remains a peer
  ];

  // Worker pane view
  const workerTeam = await resolveIntercomTeam({
    selfId: "worker-pane",
    env: {
      AGENT_INTERCOM_SCOPE_ID: "b".repeat(48),
      AGENT_INTERCOM_MANAGER_TARGET: "lead-pane",
      AGENT_INTERCOM_ROLE: "worker",
    },
    sessions,
  });
  assert.equal(workerTeam.source, "live");
  assert.equal(workerTeam.self.isManager, false);
  assert.equal(workerTeam.manager?.target, "lead-pane");
  assert.equal(workerTeam.manager?.connected, true);
  // Exact "human" excluded, lead excluded, self excluded; "Human" and "me" retained
  assert.deepEqual(workerTeam.coworkers.map((c) => c.id), ["me", "human-caps"]);

  // Lead pane view
  const leadTeam = await resolveIntercomTeam({
    selfId: "lead-pane",
    env: {
      AGENT_INTERCOM_SCOPE_ID: "b".repeat(48),
      AGENT_INTERCOM_ROLE: "manager",
    },
    sessions,
  });
  assert.equal(leadTeam.source, "live");
  assert.equal(leadTeam.self.isManager, true);
  assert.equal(leadTeam.manager?.target, "lead-pane");
  assert.deepEqual(leadTeam.coworkers.map((c) => c.id), ["worker-pane", "me", "human-caps"]);
});

test("Inbox inspection resolveManagedInboxSession is restricted strictly to Orchestrator/Boss", async () => {
  const sessions: TeamSession[] = [{ id: "manager" }, { id: "worker-1" }];
  const orchestratorTeam = {
    teamId: "manager",
    self: { id: "manager", isManager: true },
    coworkers: [{ id: "worker-1", target: "worker-1", connected: true }],
    source: "orchestrator" as const,
  };
  const bossTeam = { ...orchestratorTeam, source: "boss" as const };
  const manifestTeam = { ...orchestratorTeam, source: "manifest" as const };
  const liveTeam = { ...orchestratorTeam, source: "live" as const };
  const standaloneTeam = { ...orchestratorTeam, source: "standalone" as const };
  const legacyUndefinedSourceTeam = {
    teamId: "manager",
    self: { id: "manager", isManager: true },
    coworkers: [{ id: "worker-1", target: "worker-1", connected: true }],
  } as unknown as import("./team.ts").IntercomTeam;

  // Orchestrator allowed
  assert.equal(
    resolveManagedInboxSession({ team: orchestratorTeam, sessions, requestedSession: "worker-1" }).id,
    "worker-1",
  );

  // Boss allowed
  assert.equal(
    resolveManagedInboxSession({ team: bossTeam, sessions, requestedSession: "worker-1" }).id,
    "worker-1",
  );

  // Manifest denied
  assert.throws(
    () => resolveManagedInboxSession({ team: manifestTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator\/Boss-managed teams/,
  );

  // Live fallback denied
  assert.throws(
    () => resolveManagedInboxSession({ team: liveTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator\/Boss-managed teams/,
  );

  // Standalone denied
  assert.throws(
    () => resolveManagedInboxSession({ team: standaloneTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator\/Boss-managed teams/,
  );

  // Legacy undefined source denied
  assert.throws(
    () => resolveManagedInboxSession({ team: legacyUndefinedSourceTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator\/Boss-managed teams/,
  );
});

test("Boss Manager has self.isManager true and may inspect owned coworker inbox", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-manager-inbox-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const worker = bossWorker("worker", "boss-run-1", "participant-worker", "worker", "worker-session");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, worker] }));

    const sessions = [bossSession(manager), bossSession(worker)];
    const managerEnv = {
      AGENT_INTERCOM_WORKER_ID: "manager",
      AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
      AGENT_INTERCOM_WORKER_GENERATION: "1",
      AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
      AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
      AGENT_INTERCOM_BINDING_EPOCH: "1",
    };

    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: managerEnv,
      sessions,
    });
    assert.equal(team.source, "boss");
    assert.equal(team.self.isManager, true);
    assert.equal(team.manager?.target, "manager-session");
    assert.deepEqual(team.coworkers.map((c) => c.id), ["worker"]);

    // Manager can inspect owned coworker inbox
    const inspected = resolveManagedInboxSession({
      team,
      sessions,
      requestedSession: "worker-session",
    });
    assert.equal(inspected.id, "worker-session");

    // Worker role has self.isManager false and cannot inspect inbox
    const workerTeam = await resolveIntercomTeam({
      selfId: "worker-session",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "worker",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-worker",
        AGENT_INTERCOM_WORKER_GENERATION: "1",
        AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
        AGENT_INTERCOM_PARTICIPANT_ID: "participant-worker",
        AGENT_INTERCOM_BINDING_EPOCH: "1",
      },
      sessions,
    });
    assert.equal(workerTeam.self.isManager, false);
    assert.throws(
      () => resolveManagedInboxSession({
        team: workerTeam,
        sessions,
        requestedSession: "manager-session",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Orchestrator manager without workerId owns live workers with matching managerSessionId", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-orch-manager-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      version: 1,
      workers: [
        {
          id: "worker-a",
          managerSessionId: "manager-session",
          owned: true,
          state: "running",
          harness: "codex",
          role: "worker",
          intercomTarget: "worker-a",
        },
      ],
    }));

    const sessions: TeamSession[] = [
      { id: "manager-session", model: "codex" },
      { id: "worker-a", model: "codex" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {}, // no AGENT_INTERCOM_WORKER_ID
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, true);
    assert.equal(team.manager?.target, "manager-session");
    assert.deepEqual(team.coworkers.map((c) => c.id), ["worker-a"]);

    const inspected = resolveManagedInboxSession({
      team,
      sessions,
      requestedSession: "worker-a",
    });
    assert.equal(inspected.id, "worker-a");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Worker with missing managerSessionId in workers.json is never elevated to manager", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-orch-malformed-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      version: 1,
      workers: [
        {
          id: "worker-malformed",
          // missing managerSessionId
          state: "running",
          harness: "codex",
          role: "worker",
        },
      ],
    }));

    const sessions: TeamSession[] = [
      { id: "worker-malformed", model: "codex" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "worker-malformed",
      agentDir,
      env: { AGENT_INTERCOM_WORKER_ID: "worker-malformed" },
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers, []);

    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-malformed",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Current worker record missing stored managerSessionId + AGENT_INTERCOM_MANAGER_TARGET=selfId + owned peer => source orchestrator but self false and inbox denied", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-orch-no-mgr-elev-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      version: 1,
      workers: [
        {
          id: "worker-me",
          // missing managerSessionId
          owned: true,
          state: "running",
          harness: "codex",
          role: "worker",
          intercomTarget: "worker-me",
        },
        {
          id: "worker-peer",
          managerSessionId: "worker-me",
          owned: true,
          state: "running",
          harness: "codex",
          role: "worker",
          intercomTarget: "worker-peer",
        },
      ],
    }));

    const sessions: TeamSession[] = [
      { id: "worker-me", model: "codex" },
      { id: "worker-peer", model: "codex" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "worker-me",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "worker-me",
        AGENT_INTERCOM_MANAGER_TARGET: "worker-me",
      },
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager?.target, "worker-me");
    assert.deepEqual(team.coworkers.map((c) => c.id), ["worker-peer"]);

    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-peer",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Stale or unmatched worker ID + owned records targeting self => no orchestrator Manager/inbox; continue manifest/live/standalone resolution", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-stale-worker-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      version: 1,
      workers: [
        {
          id: "worker-owned",
          managerSessionId: "self-manager",
          owned: true,
          state: "running",
          harness: "codex",
          role: "worker",
          intercomTarget: "worker-owned",
        },
      ],
    }));

    const sessions: TeamSession[] = [
      { id: "self-manager", model: "codex" },
      { id: "worker-owned", model: "codex" },
    ];
    // Stale/unmatched AGENT_INTERCOM_WORKER_ID present
    const team = await resolveIntercomTeam({
      selfId: "self-manager",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "nonexistent-stale-worker",
        AGENT_INTERCOM_SCOPE_ID: "e".repeat(48),
      },
      sessions,
    });
    // Falls through to live roster resolution
    assert.equal(team.source, "live");
    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-owned",
      }),
      /Pending-ask inbox access denied: cross-session inbox inspection is only permitted for Orchestrator\/Boss-managed teams/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Adversarial: exact Boss Manager session/roster with Boss env keys absent yields deny-all boss team without Manager/coworkers/inbox", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-noenv-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const worker = bossWorker("worker", "boss-run-1", "participant-worker", "worker", "worker-session");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, worker] }));

    const sessions = [bossSession(manager), bossSession(worker)];
    // Manager live session has Boss metadata, but Boss environment variables are completely absent
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {}, // No Boss env keys!
      sessions,
    });
    assert.equal(team.source, "boss");
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers, []);

    // Inbox inspection must fail closed
    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-session",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Adversarial: exact Boss Manager session/roster with partial Boss env keys yields deny-all boss team without Manager/coworkers/inbox", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-partialenv-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const worker = bossWorker("worker", "boss-run-1", "participant-worker", "worker", "worker-session");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, worker] }));

    const sessions = [bossSession(manager), bossSession(worker)];
    // Partial Boss env keys (missing participantId and bindingEpoch)
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "manager",
        AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
      },
      sessions,
    });
    assert.equal(team.source, "boss");
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers, []);

    // Inbox inspection must fail closed
    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-session",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
