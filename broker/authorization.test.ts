import assert from "node:assert/strict";
import test from "node:test";
import { authorizeSessionAction, visibleSessions } from "./authorization.ts";
import type { SessionInfo } from "../types.ts";
import { BOSS_PARTICIPANT_BINDING_VERSION, BOSS_RUN_FEATURE_CONTRACT, type BossParticipantRole } from "@ctliz/agent-intercom-core/boss";

function local(id: string): SessionInfo {
  return { id, name: id, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, origin: "local" };
}

function remote(id: string, parentSessionId: string, rootSessionId = "root"): SessionInfo {
  return {
    id,
    name: id,
    cwd: "/tmp",
    model: "test",
    pid: 2,
    startedAt: 1,
    lastActivity: 1,
    origin: "remote",
    remoteHostId: "ika",
    parentSessionId,
    rootSessionId,
    generation: 1,
  };
}

const sessions = [
  local("root"),
  local("unrelated"),
  remote("manager", "root"),
  remote("child-a", "manager"),
  remote("child-b", "manager"),
];

function boss(
  id: string,
  bossRunId: string,
  participantId: string,
  role: BossParticipantRole,
  options: { manager?: string; assigned?: string[] } = {},
): SessionInfo {
  return {
    ...local(id),
    boss: {
      featureContract: BOSS_RUN_FEATURE_CONTRACT,
      binding: {
        version: BOSS_PARTICIPANT_BINDING_VERSION,
        bossRunId,
        participantId,
        role,
        communicationProfile: role,
        bindingEpoch: 1,
        sessionId: id,
        brokerGeneration: 1,
        brokerBootInstance: "boot-1",
        state: "active",
        ...(options.manager === undefined ? {} : { assignedManagerParticipantId: options.manager }),
        authorityTransitionId: "transition-1",
      },
      brokerIdentityVerified: true,
      ...(options.assigned === undefined ? {} : { assignedParticipantIds: options.assigned }),
    },
  };
}

test("phase one discovery and communication use the same ancestor-chain policy", () => {
  assert.equal(authorizeSessionAction(sessions, "root", "send", "manager").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "manager", "ask", "root").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "manager", "send", "child-a").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "child-a", "reply", "manager").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "child-a", "send", "root").allowed, true);
  assert.equal(authorizeSessionAction(sessions, "child-a", "discover", "child-b").allowed, false);
  assert.equal(authorizeSessionAction(sessions, "unrelated", "discover", "manager").allowed, false);
});

test("visibility hides unauthorized sessions rather than revealing denial details", () => {
  assert.deepEqual(visibleSessions(sessions, "child-a").map((session) => session.id).sort(), ["child-a", "manager", "root"]);
  assert.deepEqual(visibleSessions(sessions, "root").map((session) => session.id).sort(), ["child-a", "child-b", "manager", "root", "unrelated"]);
  assert.deepEqual(visibleSessions(sessions, "unrelated").map((session) => session.id).sort(), ["root", "unrelated"]);
});

test("Boss registrations are isolated from ordinary sessions and other runs", () => {
  const bossSessions = [
    local("ordinary"),
    boss("manager", "run-1", "manager-1", "manager", { assigned: ["worker-1"] }),
    boss("worker", "run-1", "worker-1", "worker", { manager: "manager-1" }),
    boss("other-run", "run-2", "worker-2", "worker", { manager: "manager-2" }),
  ];
  assert.equal(authorizeSessionAction(bossSessions, "manager", "send", "worker").allowed, true);
  assert.equal(authorizeSessionAction(bossSessions, "worker", "discover", "other-run").allowed, false);
  assert.equal(authorizeSessionAction(bossSessions, "ordinary", "discover", "worker").allowed, false);
  assert.deepEqual(visibleSessions(bossSessions, "worker").map((session) => session.id).sort(), ["manager", "worker"]);
});

test("Boss structured control uses the directional Core policy matrix", () => {
  const bossSessions = [
    boss("manager", "run-1", "manager-1", "manager", { assigned: ["worker-1"] }),
    boss("worker", "run-1", "worker-1", "worker", { manager: "manager-1" }),
  ];
  assert.equal(authorizeSessionAction(
    bossSessions,
    "manager",
    "control",
    "worker",
    { controlKind: "assignment_request", correlated: true },
  ).allowed, true);
  assert.equal(authorizeSessionAction(
    bossSessions,
    "worker",
    "control",
    "manager",
    { controlKind: "assignment_request", correlated: true },
  ).allowed, false);
});
