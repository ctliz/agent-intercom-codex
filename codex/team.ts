import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDirPath } from "../broker/paths.ts";
import {
  BOSS_PARTICIPANT_ROLES,
  parseParticipantState,
  parseWorkerIdentityV2,
  workerIdentityFromEnvironment,
  type WorkerIdentityV2,
} from "@ctliz/agent-intercom-core/boss";

export interface TeamSession {
  id: string;
  name?: string;
  boss?: {
    binding?: {
      bossRunId?: unknown;
      participantId?: unknown;
      bindingEpoch?: unknown;
      role?: unknown;
      sessionId?: unknown;
      state?: unknown;
    };
    workerIdentity?: unknown;
    participantState?: unknown;
  };
}

interface StoredWorker {
  id?: unknown;
  runId?: unknown;
  workerIncarnationId?: unknown;
  workerGeneration?: unknown;
  bossRunId?: unknown;
  participantId?: unknown;
  bindingEpoch?: unknown;
  harness?: unknown;
  role?: unknown;
  state?: unknown;
  owned?: unknown;
  managerSessionId?: unknown;
  intercomTarget?: unknown;
  canonicalIdentity?: WorkerIdentityV2;
}

export interface TeamMember { id: string; target: string; harness?: string; role?: string; state?: string; connected: boolean; }
export interface IntercomTeam { teamId?: string; self: { id: string; workerId?: string; isManager: boolean }; manager?: { target: string; connected: boolean }; coworkers: TeamMember[]; }

const LEGACY_LIVE_STATES = new Set(["provisioning", "running", "idle", "needs_attention", "stopping"]);
const CANONICAL_LIVE_STATES = new Set(["provisioning", "registering", "ready", "working", "waiting", "paused", "stalled", "blocked", "unreachable"]);
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const connectedTo = (sessions: TeamSession[], target: string): boolean => {
  const normalized = target.toLowerCase();
  return sessions.some((session) => session.id === target || session.name?.toLowerCase() === normalized);
};

function bossIdentityFromEnvironment(env: NodeJS.ProcessEnv): WorkerIdentityV2 | undefined {
  const bossKeys = ["AGENT_INTERCOM_BOSS_RUN_ID", "AGENT_INTERCOM_PARTICIPANT_ID", "AGENT_INTERCOM_BINDING_EPOCH"] as const;
  if (!bossKeys.some((key) => env[key] !== undefined)) return undefined;
  const identity = workerIdentityFromEnvironment(env);
  if (!("bossRunId" in identity)) throw new Error("Incomplete Boss worker identity cannot discover a team");
  return identity;
}

function canonicalWorker(value: unknown): StoredWorker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("worker must be an object");
  const worker = value as StoredWorker;
  const identity = parseWorkerIdentityV2({
    version: "orc.worker-identity.v2",
    workerId: worker.id,
    workerIncarnationId: worker.workerIncarnationId,
    workerGeneration: worker.workerGeneration,
    ...(worker.bossRunId === undefined ? {} : { bossRunId: worker.bossRunId }),
    ...(worker.participantId === undefined ? {} : { participantId: worker.participantId }),
    ...(worker.bindingEpoch === undefined ? {} : { bindingEpoch: worker.bindingEpoch }),
  });
  parseParticipantState(worker.state, "$.worker.state");
  if (typeof worker.role !== "string" || !BOSS_PARTICIPANT_ROLES.includes(worker.role as never)) {
    throw new Error("worker role is not canonical");
  }
  if (worker.owned !== true || !stringValue(worker.managerSessionId) || !stringValue(worker.intercomTarget)) {
    throw new Error("canonical worker ownership routing is incomplete");
  }
  return { ...worker, canonicalIdentity: identity };
}

function exactBossRosterSession(sessions: TeamSession[], worker: StoredWorker): TeamSession | undefined {
  const identity = worker.canonicalIdentity;
  const target = stringValue(worker.intercomTarget);
  const role = stringValue(worker.role);
  const state = stringValue(worker.state);
  if (!identity || !("bossRunId" in identity) || !target || !role || !state) return undefined;
  const matches = sessions.filter((candidate) => candidate.id === target);
  if (matches.length !== 1) return undefined;
  const [session] = matches;
  if (!session?.boss?.binding || session.boss.workerIdentity === undefined || session.boss.participantState === undefined) return undefined;
  try {
    const sessionIdentity = parseWorkerIdentityV2(session.boss.workerIdentity);
    const sessionState = parseParticipantState(session.boss.participantState, "$.session.boss.participantState");
    const binding = session.boss.binding;
    return (
      "bossRunId" in sessionIdentity
      && session.id === target
      && binding.sessionId === session.id
      && binding.state === "active"
      && binding.bossRunId === identity.bossRunId
      && binding.participantId === identity.participantId
      && binding.bindingEpoch === identity.bindingEpoch
      && binding.role === role
      && sessionIdentity.workerId === identity.workerId
      && sessionIdentity.workerIncarnationId === identity.workerIncarnationId
      && sessionIdentity.workerGeneration === identity.workerGeneration
      && sessionIdentity.bossRunId === identity.bossRunId
      && sessionIdentity.participantId === identity.participantId
      && sessionIdentity.bindingEpoch === identity.bindingEpoch
      && sessionState === state
    ) ? session : undefined;
  } catch {
    return undefined;
  }
}

async function readWorkers(agentDir: string): Promise<{ version: 1 | 2; workers: StoredWorker[] }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(agentDir, "intercom", "orchestrator", "workers.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("worker snapshot must be an object");
    const snapshot = parsed as { version?: unknown; workers?: unknown };
    if ((snapshot.version !== 1 && snapshot.version !== 2) || !Array.isArray(snapshot.workers)) throw new Error("unsupported worker snapshot version");
    if (snapshot.version === 1) return { version: 1, workers: snapshot.workers as StoredWorker[] };
    return { version: 2, workers: snapshot.workers.map(canonicalWorker) };
  } catch {
    return { version: 1, workers: [] };
  }
}

export async function resolveIntercomTeam(input: { selfId: string; sessions: TeamSession[]; env?: NodeJS.ProcessEnv; agentDir?: string }): Promise<IntercomTeam> {
  const env = input.env ?? process.env;
  const snapshot = await readWorkers(input.agentDir ?? getAgentDirPath());
  const workers = snapshot.workers;
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  const bossIdentity = bossIdentityFromEnvironment(env);
  const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);
  const currentMatches = workerId ? workers.filter((worker) => (
    stringValue(worker.id) === workerId
    && (bossIdentity === undefined
      ? (!runId || stringValue(worker.runId) === runId)
      : snapshot.version === 2
        && worker.canonicalIdentity?.workerId === bossIdentity.workerId
        && worker.canonicalIdentity.workerIncarnationId === bossIdentity.workerIncarnationId
        && worker.canonicalIdentity.workerGeneration === bossIdentity.workerGeneration
        && "bossRunId" in worker.canonicalIdentity
        && "bossRunId" in bossIdentity
        && worker.canonicalIdentity.bossRunId === bossIdentity.bossRunId
        && worker.canonicalIdentity.participantId === bossIdentity.participantId
        && worker.canonicalIdentity.bindingEpoch === bossIdentity.bindingEpoch)
  )) : [];
  const current = bossIdentity === undefined ? currentMatches[0] : currentMatches.length === 1 ? currentMatches[0] : undefined;
  const currentTarget = stringValue(current?.intercomTarget);
  const exactCurrentProjection = current !== undefined
    && currentTarget === input.selfId
    && workers.filter((worker) => stringValue(worker.id) === workerId).length === 1
    && workers.filter((worker) => stringValue(worker.intercomTarget) === currentTarget).length === 1
    && exactBossRosterSession(input.sessions, current) !== undefined;

  // Privileged Boss discovery is rooted in one exact current worker/session
  // projection. A substituted self ID, ambiguous ID/target, or stale binding
  // never unlocks a roster assembled from ambient same-run records.
  if (bossIdentity !== undefined && !exactCurrentProjection) {
    return { self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: false }, coworkers: [] };
  }

  const managerTarget = stringValue(current?.managerSessionId)
    ?? (bossIdentity === undefined ? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET) ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID) : undefined);
  const teamId = managerTarget ?? input.selfId;
  const currentRole = stringValue(current?.role);
  const canDiscoverOwnedRoster = bossIdentity === undefined || currentRole === "manager" || currentRole === "controller";
  const coworkers = (canDiscoverOwnedRoster ? workers : []).filter((worker) => worker.owned === true)
    .filter((worker) => bossIdentity === undefined || (
      snapshot.version === 2
      && worker.canonicalIdentity !== undefined
      && "bossRunId" in worker.canonicalIdentity
      && "bossRunId" in bossIdentity
      && worker.canonicalIdentity.bossRunId === bossIdentity.bossRunId
    ))
    .filter((worker) => stringValue(worker.managerSessionId) === teamId)
    .filter((worker) => stringValue(worker.intercomTarget) !== managerTarget)
    .filter((worker) => (snapshot.version === 2 ? CANONICAL_LIVE_STATES : LEGACY_LIVE_STATES).has(stringValue(worker.state) ?? ""))
    .filter((worker) => stringValue(worker.id) !== workerId)
    .map((worker): TeamMember | undefined => {
      const id = stringValue(worker.id);
      if (!id) return undefined;
      const target = stringValue(worker.intercomTarget) ?? id;
      const connected = bossIdentity === undefined
        ? connectedTo(input.sessions, target)
        : exactBossRosterSession(input.sessions, worker) !== undefined;
      if (!connected) return undefined;
      return {
        id,
        target,
        ...(stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}),
        ...(stringValue(worker.role) ? { role: stringValue(worker.role) } : {}),
        ...(stringValue(worker.state) ? { state: stringValue(worker.state) } : {}),
        connected,
      };
    }).filter((member): member is TeamMember => Boolean(member));

  const managerWorker = managerTarget === undefined
    ? undefined
    : workers.find((worker) => (
      stringValue(worker.intercomTarget) === managerTarget
      && (bossIdentity === undefined || (
        snapshot.version === 2
        && stringValue(worker.role) === "manager"
        && worker.canonicalIdentity !== undefined
        && "bossRunId" in worker.canonicalIdentity
        && "bossRunId" in bossIdentity
        && worker.canonicalIdentity.bossRunId === bossIdentity.bossRunId
      ))
    ));
  const managerConnected = managerTarget === undefined
    ? true
    : bossIdentity === undefined
      ? connectedTo(input.sessions, managerTarget)
      : managerWorker !== undefined && exactBossRosterSession(input.sessions, managerWorker) !== undefined;
  return {
    teamId,
    self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: bossIdentity === undefined && !managerTarget },
    ...(managerTarget
      ? { manager: { target: managerTarget, connected: managerConnected } }
      : bossIdentity === undefined ? { manager: { target: input.selfId, connected: true } } : {}),
    coworkers,
  };
}

export function formatIntercomTeam(team: IntercomTeam): string {
  const lines = [
    `Manager: ${team.manager ? `${team.manager.target} [${team.manager.connected ? "connected" : "not connected"}]` : "unknown"}`,
    `You: ${team.self.workerId ?? team.self.id}${team.self.isManager ? " [manager]" : ""}`,
  ];
  if (!team.coworkers.length) lines.push("Coworkers: none");
  else {
    lines.push("Coworkers:");
    for (const coworker of team.coworkers) {
      const metadata = [coworker.harness, coworker.role, coworker.state].filter(Boolean).join(", ");
      lines.push(`- ${coworker.id} target=${coworker.target}${metadata ? ` (${metadata})` : ""} [${coworker.connected ? "connected" : "not connected"}]`);
    }
  }
  return lines.join("\n");
}
