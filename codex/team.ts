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
import { readTeamManifestAsync, TeamManifestError } from "@ctliz/agent-intercom-core/team-manifest";

export type TeamSource = "orchestrator" | "boss" | "manifest" | "live" | "standalone";

export interface TeamSession {
  id: string;
  name?: string;
  model?: string;
  origin?: "local" | "remote";
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

export interface TeamMember {
  id: string;
  target: string;
  harness?: string;
  role?: string;
  state?: string;
  connected: boolean;
}

export interface IntercomTeam {
  teamId?: string;
  self: { id: string; workerId?: string; isManager: boolean };
  manager?: { target: string; connected: boolean };
  coworkers: TeamMember[];
  source: TeamSource;
}

const LEGACY_LIVE_STATES = new Set(["provisioning", "running", "idle", "needs_attention", "stopping"]);
const CANONICAL_LIVE_STATES = new Set(["provisioning", "registering", "ready", "working", "waiting", "paused", "stalled", "blocked", "unreachable"]);
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const connectedTo = (sessions: TeamSession[], target: string): boolean => {
  const normalized = target.toLowerCase();
  return sessions.some((session) => session.id === target || session.name?.toLowerCase() === normalized);
};

function hasBossEnvironmentKeys(env: NodeJS.ProcessEnv): boolean {
  const bossKeys = [
    "AGENT_INTERCOM_BOSS_RUN_ID",
    "AGENT_INTERCOM_PARTICIPANT_ID",
    "AGENT_INTERCOM_BINDING_EPOCH",
    "AGENT_INTERCOM_WORKER_INCARNATION_ID",
    "AGENT_INTERCOM_WORKER_GENERATION",
  ] as const;
  return bossKeys.some((key) => env[key] !== undefined);
}

function bossIdentityFromEnvironment(env: NodeJS.ProcessEnv): WorkerIdentityV2 | undefined {
  if (!hasBossEnvironmentKeys(env)) return undefined;
  try {
    const identity = workerIdentityFromEnvironment(env);
    if (!("bossRunId" in identity)) return undefined;
    return identity;
  } catch {
    return undefined;
  }
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

async function resolveNonAuthoritativeTeam(
  input: { selfId: string; sessions: TeamSession[] },
  env: NodeJS.ProcessEnv,
): Promise<IntercomTeam> {
  if (env.AGENT_INTERCOM_TEAM_MANIFEST !== undefined) {
    const rawPath = env.AGENT_INTERCOM_TEAM_MANIFEST.trim();
    if (!rawPath) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }
    const manifest = await readTeamManifestAsync(rawPath);
    if (!manifest) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }
    const selfMember = manifest.members.find((m) => m.sessionId === input.selfId);
    if (!selfMember) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }

    const isManager = input.selfId === manifest.leadId;
    const managerTarget = manifest.leadId;
    const managerConnected = connectedTo(input.sessions, managerTarget);

    const coworkers: TeamMember[] = manifest.members
      .filter((m) => m.sessionId !== input.selfId)
      .filter((m) => isManager || m.sessionId !== managerTarget)
      .map((m) => {
        const live = input.sessions.find((s) => s.id === m.sessionId || s.name === m.sessionId);
        return {
          id: m.sessionId,
          target: m.sessionId,
          role: m.role,
          connected: Boolean(live),
        };
      });

    return {
      teamId: manifest.runId,
      self: { id: input.selfId, isManager },
      manager: { target: managerTarget, connected: managerConnected },
      coworkers,
      source: "manifest",
    };
  }

  if (stringValue(env.AGENT_INTERCOM_SCOPE_ID)) {
    const managerTarget = stringValue(env.AGENT_INTERCOM_MANAGER_TARGET)
      ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
    const role = stringValue(env.AGENT_INTERCOM_ROLE)?.toLowerCase();

    const isManager = role === "manager"
      || (managerTarget !== undefined && managerTarget === input.selfId)
      || (managerTarget === undefined && role !== "worker");

    const effectiveManagerTarget = isManager ? input.selfId : managerTarget;

    const coworkers: TeamMember[] = input.sessions
      .filter((session) => session.id !== input.selfId)
      .filter((session) => session.model !== "human")
      .filter((session) => session.id !== effectiveManagerTarget)
      .map((session): TeamMember => ({
        id: session.id,
        target: session.id,
        ...(session.model ? { harness: session.model } : {}),
        connected: true,
      }));

    const manager = effectiveManagerTarget
      ? {
          target: effectiveManagerTarget,
          connected: isManager ? true : connectedTo(input.sessions, effectiveManagerTarget),
        }
      : undefined;

    return {
      teamId: effectiveManagerTarget ?? input.selfId,
      self: { id: input.selfId, isManager },
      ...(manager ? { manager } : {}),
      coworkers,
      source: "live",
    };
  }

  const managerTarget = stringValue(env.AGENT_INTERCOM_MANAGER_TARGET)
    ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
  return {
    teamId: managerTarget ?? input.selfId,
    self: { id: input.selfId, isManager: !managerTarget },
    manager: managerTarget
      ? { target: managerTarget, connected: connectedTo(input.sessions, managerTarget) }
      : { target: input.selfId, connected: true },
    coworkers: [],
    source: "standalone",
  };
}

export async function resolveIntercomTeam(input: { selfId: string; sessions: TeamSession[]; env?: NodeJS.ProcessEnv; agentDir?: string }): Promise<IntercomTeam> {
  const env = input.env ?? process.env;
  const snapshot = await readWorkers(input.agentDir ?? getAgentDirPath());
  const workers = snapshot.workers;
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  const selfSession = input.sessions.find((session) => session.id === input.selfId);
  const isBossContext = selfSession?.boss !== undefined || hasBossEnvironmentKeys(env);
  const bossIdentity = bossIdentityFromEnvironment(env);
  const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);

  if (isBossContext && bossIdentity === undefined) {
    return {
      self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: false },
      coworkers: [],
      source: "boss",
    };
  }

  const currentMatches = workerId ? workers.filter((worker) => (
    stringValue(worker.id) === workerId
    && (bossIdentity === undefined
      ? (snapshot.version === 1 && (!runId || stringValue(worker.runId) === runId))
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
    return { self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: false }, coworkers: [], source: "boss" };
  }

  if (bossIdentity === undefined && !current) {
    if (workerId === undefined && snapshot.version === 1) {
      const ownedCoworkers = workers
        .filter((worker) => worker.owned === true)
        .filter((worker) => {
          const mgr = stringValue(worker.managerSessionId);
          return mgr !== undefined && mgr === input.selfId;
        })
        .filter((worker) => LEGACY_LIVE_STATES.has(stringValue(worker.state) ?? ""))
        .filter((worker) => stringValue(worker.id) !== input.selfId)
        .map((worker): TeamMember | undefined => {
          const id = stringValue(worker.id);
          if (!id) return undefined;
          const target = stringValue(worker.intercomTarget) ?? id;
          return {
            id,
            target,
            ...(stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}),
            ...(stringValue(worker.role) ? { role: stringValue(worker.role) } : {}),
            ...(stringValue(worker.state) ? { state: stringValue(worker.state) } : {}),
            connected: connectedTo(input.sessions, target),
          };
        })
        .filter((member): member is TeamMember => Boolean(member));

      if (ownedCoworkers.length > 0) {
        return {
          teamId: input.selfId,
          self: { id: input.selfId, isManager: true },
          manager: { target: input.selfId, connected: true },
          coworkers: ownedCoworkers,
          source: "orchestrator",
        };
      }
    }

    return resolveNonAuthoritativeTeam(input, env);
  }

  const currentRole = stringValue(current?.role);
  const selfIsManager = bossIdentity !== undefined
    ? currentRole === "manager"
    : undefined;

  const managerTarget = bossIdentity !== undefined
    ? (selfIsManager ? input.selfId : stringValue(current?.managerSessionId))
    : stringValue(current?.managerSessionId) ?? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET) ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);

  if (bossIdentity === undefined && !managerTarget) {
    return {
      self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: false },
      coworkers: [],
      source: "orchestrator",
    };
  }

  const teamId = bossIdentity !== undefined
    ? ("bossRunId" in bossIdentity ? bossIdentity.bossRunId : managerTarget ?? input.selfId)
    : (managerTarget ?? input.selfId);

  const canDiscoverOwnedRoster = bossIdentity === undefined || currentRole === "manager" || currentRole === "controller";
  const coworkers = (canDiscoverOwnedRoster ? workers : []).filter((worker) => worker.owned === true)
    .filter((worker) => bossIdentity === undefined || (
      snapshot.version === 2
      && worker.canonicalIdentity !== undefined
      && "bossRunId" in worker.canonicalIdentity
      && "bossRunId" in bossIdentity
      && worker.canonicalIdentity.bossRunId === bossIdentity.bossRunId
    ))
    .filter((worker) => stringValue(worker.managerSessionId) === (bossIdentity !== undefined ? managerTarget : teamId))
    .filter((worker) => stringValue(worker.intercomTarget) !== managerTarget)
    .filter((worker) => (snapshot.version === 2 ? CANONICAL_LIVE_STATES : LEGACY_LIVE_STATES).has(stringValue(worker.state) ?? ""))
    .filter((worker) => stringValue(worker.id) !== workerId && stringValue(worker.id) !== input.selfId)
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

  const isManager = bossIdentity !== undefined
    ? selfIsManager!
    : false;

  return {
    teamId,
    self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager },
    ...(managerTarget
      ? { manager: { target: managerTarget, connected: isManager ? true : managerConnected } }
      : {}),
    coworkers,
    source: bossIdentity !== undefined ? "boss" : "orchestrator",
  };
}

/** Authorizes a read-only local inbox lookup using exact orchestrator ownership. */
export function resolveManagedInboxSession(input: {
  team: IntercomTeam;
  sessions: TeamSession[];
  requestedSession: string;
}): TeamSession {
  if (input.team.source !== "orchestrator" && input.team.source !== "boss") {
    throw new Error("Pending-ask inbox access denied: cross-session inbox inspection is only permitted for Orchestrator/Boss-managed teams");
  }
  if (!input.team.self.isManager) {
    throw new Error("Only a manager may inspect another session's pending-ask inbox");
  }
  const member = input.team.coworkers.find((entry) => entry.target === input.requestedSession);
  if (!member) {
    throw new Error(`Pending-ask inbox access denied for "${input.requestedSession}"; select an owned coworker target returned by intercom_team`);
  }
  const liveSession = input.sessions.find((session) => session.id === input.requestedSession);
  if (!liveSession) {
    throw new Error(`Pending-ask inbox access denied for "${input.requestedSession}"; the owned coworker target must equal an exact connected stable session ID`);
  }
  if (liveSession.origin === "remote") {
    throw new Error(`Pending-ask inbox "${input.requestedSession}" is remote and cannot be read from this host`);
  }
  return liveSession;
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
