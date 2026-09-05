import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureIntercomRuntimeDir, getAgentDirPath, getIntercomDirPath } from "../broker/paths.ts";
import { writeDurableJson } from "../durable-json.ts";

export const NAMED_TEAMS_FILE = "named-teams.json";
export const NAMED_TEAMS_VERSION = 1;
export const NAMED_TEAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export interface NamedTeam {
  name: string;
  scopeId: string;
  managerSessionId: string;
  createdAt: number;
}

interface NamedTeamsFile {
  version: number;
  teams: NamedTeam[];
}

function isNamedTeamScope(value: string): boolean {
  if (value.length !== 48) return false;
  for (const char of value) {
    if (!((char >= "0" && char <= "9") || (char >= "a" && char <= "f"))) return false;
  }
  return true;
}

function teamsFilePath(agentDir?: string): string {
  return join(getIntercomDirPath(agentDir ?? getAgentDirPath()), NAMED_TEAMS_FILE);
}

function genericReadError(): Error {
  return new Error("Could not read the local named-team list.");
}

function genericWriteError(): Error {
  return new Error("Could not create that named team.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredTeam(value: unknown): NamedTeam | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.name !== "string" || !NAMED_TEAM_NAME_PATTERN.test(value.name)) return undefined;
  if (typeof value.scopeId !== "string" || !isNamedTeamScope(value.scopeId)) return undefined;
  if (typeof value.managerSessionId !== "string" || !value.managerSessionId.trim()) return undefined;
  if (value.managerSessionId !== value.managerSessionId.trim() || /[\u0000-\u001f\u007f]/.test(value.managerSessionId)) {
    return undefined;
  }
  if (typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    return undefined;
  }
  return {
    name: value.name,
    scopeId: value.scopeId,
    managerSessionId: value.managerSessionId,
    createdAt: value.createdAt,
  };
}

export function rejectManagedJoin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AGENT_INTERCOM_WORKER_ID?.trim() || env.AGENT_INTERCOM_OWNED === "1" || env.AGENT_INTERCOM_TEAM_MANIFEST?.trim()) {
    return "This session is already a managed member and cannot join another team.";
  }
  return undefined;
}

export function parseTeamName(raw: string): string {
  const name = raw.trim();
  if (!name || name.includes(" ") || !NAMED_TEAM_NAME_PATTERN.test(name)) {
    throw new Error("Team names start with a letter and may include letters, numbers, hyphens, or underscores (max 32).");
  }
  return name;
}

export function generateNamedTeamScope(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const scopeId = randomBytes(24).toString("hex");
    if (!taken.has(scopeId)) return scopeId;
  }
  throw genericWriteError();
}

export function listNamedTeams(agentDir?: string): NamedTeam[] {
  let raw: string;
  try {
    raw = readFileSync(teamsFilePath(agentDir), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw genericReadError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw genericReadError();
  }
  if (!isPlainObject(parsed) || parsed.version !== NAMED_TEAMS_VERSION || !Array.isArray(parsed.teams)) {
    throw genericReadError();
  }

  const teams: NamedTeam[] = [];
  const names = new Set<string>();
  const scopes = new Set<string>();
  for (const entry of parsed.teams) {
    const team = parseStoredTeam(entry);
    if (!team || names.has(team.name) || scopes.has(team.scopeId)) throw genericReadError();
    names.add(team.name);
    scopes.add(team.scopeId);
    teams.push(team);
  }
  return teams;
}

export function findNamedTeam(name: string, agentDir?: string): NamedTeam | undefined {
  return listNamedTeams(agentDir).find((team) => team.name === name);
}

export function createNamedTeam(input: {
  name: string;
  managerSessionId: string;
  agentDir?: string;
  now?: number;
  generateScope?: () => string;
}): NamedTeam {
  const name = parseTeamName(input.name);
  const managerSessionId = input.managerSessionId.trim();
  if (!managerSessionId || managerSessionId !== input.managerSessionId || /[\u0000-\u001f\u007f]/.test(managerSessionId)) {
    throw genericWriteError();
  }

  const existing = listNamedTeams(input.agentDir);
  if (existing.some((team) => team.name === name)) {
    throw new Error(`A named team called ${name} already exists.`);
  }

  const scopeId = (input.generateScope ?? (() => generateNamedTeamScope(existing.map((team) => team.scopeId))))();
  if (!isNamedTeamScope(scopeId) || existing.some((team) => team.scopeId === scopeId)) {
    throw genericWriteError();
  }

  const team: NamedTeam = {
    name,
    scopeId,
    managerSessionId,
    createdAt: input.now ?? Date.now(),
  };
  const dir = getIntercomDirPath(input.agentDir ?? getAgentDirPath());
  ensureIntercomRuntimeDir(dir);
  const payload: NamedTeamsFile = { version: NAMED_TEAMS_VERSION, teams: [...existing, team] };
  writeDurableJson(teamsFilePath(input.agentDir), payload);
  return team;
}

export function formatJoinableNamedTeamList(teams: Array<Pick<NamedTeam, "name">>): string {
  if (teams.length === 0) {
    return "No joinable named teams found.\nCreate one with intercom_join({ name: \"billing\", create: true }).";
  }
  return [
    "Joinable named teams:",
    ...teams.map((team, index) => `  ${index + 1}) ${team.name}`),
  ].join("\n");
}

export function formatCreateSuccess(input: { team: string; name: string }): string {
  return `Created team ${input.team} and joined as manager.\nDisplay name: ${input.name}`;
}

export function formatNamedJoinSuccess(input: { team: string; name: string }): string {
  return `Joined team ${input.team}.\nRole: teammate\nDisplay name: ${input.name}`;
}
