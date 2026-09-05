import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNamedTeam,
  findNamedTeam,
  formatCreateSuccess,
  formatJoinableNamedTeamList,
  formatNamedJoinSuccess,
  generateNamedTeamScope,
  listNamedTeams,
  parseTeamName,
  rejectManagedJoin,
} from "./named-teams.ts";

const VALID_SCOPE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function withTempAgentDir(run: (agentDir: string) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), "named-teams-"));
  try {
    run(agentDir);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("parseTeamName rejects numbers, flags, and punctuation", () => {
  assert.equal(parseTeamName("billing"), "billing");
  assert.throws(() => parseTeamName("1"), /Team names start with a letter/);
  assert.throws(() => parseTeamName("-billing"), /Team names start with a letter/);
  assert.throws(() => parseTeamName("has space"), /Team names start with a letter/);
});

test("generateNamedTeamScope is 48 lowercase hex", () => {
  const first = generateNamedTeamScope();
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.notEqual(generateNamedTeamScope([first]), first);
});

test("createNamedTeam persists a team without leaking the scope", () => {
  withTempAgentDir((agentDir) => {
    const created = createNamedTeam({
      name: "billing",
      managerSessionId: "planner-id",
      agentDir,
      now: 1_700_000_000_000,
      generateScope: () => VALID_SCOPE,
    });
    assert.equal(created.name, "billing");
    assert.deepEqual(listNamedTeams(agentDir), [created]);
    assert.deepEqual(findNamedTeam("billing", agentDir), created);
    const stored = readFileSync(join(agentDir, "intercom", "named-teams.json"), "utf8");
    assert.match(stored, /"name":"billing"/);
    assert.throws(
      () => createNamedTeam({ name: "billing", managerSessionId: "other", agentDir }),
      /already exists/,
    );
    const listed = formatJoinableNamedTeamList([{ name: "billing" }]);
    assert.match(listed, /  1\) billing/);
    assert.doesNotMatch(listed, new RegExp(VALID_SCOPE));
    assert.doesNotMatch(formatCreateSuccess({ team: "billing", name: "planner" }), new RegExp(VALID_SCOPE));
    assert.doesNotMatch(formatNamedJoinSuccess({ team: "billing", name: "worker" }), new RegExp(VALID_SCOPE));
  });
});

test("rejectManagedJoin blocks orchestrator and team-manifest sessions", () => {
  assert.equal(rejectManagedJoin({}), undefined);
  assert.match(rejectManagedJoin({ AGENT_INTERCOM_WORKER_ID: "w1" }) ?? "", /managed member/);
  assert.match(rejectManagedJoin({ AGENT_INTERCOM_TEAM_MANIFEST: "/tmp/team.json" }) ?? "", /managed member/);
});
