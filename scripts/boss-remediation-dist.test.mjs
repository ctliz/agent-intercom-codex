import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexBridgeDaemon } from "../dist/bridge-daemon.mjs";
import {
  assertHardenedBossCoiLaunch,
  buildCoiTuiArgs,
  hasCodexHelpOrVersion,
  resolveCoiResumeRequest,
  runCoi,
  runInteractiveTui,
} from "../dist/coi.mjs";

test("built coi preserves separator and enforces the same hostile argv ceiling", () => {
  assert.deepEqual(buildCoiTuiArgs("unix:///tmp/coi.sock", [], "thread-1", ["--literal"], false), [
    "--remote", "unix:///tmp/coi.sock", "--", "--literal",
  ]);
  assert.equal(hasCodexHelpOrVersion(["--", "--help"]), false);
  assert.deepEqual(resolveCoiResumeRequest(["--", "resume", "attacker-thread"]), {
    optionArgs: [],
    promptArgs: ["resume", "attacker-thread"],
  });
  assert.throws(() => assertHardenedBossCoiLaunch(["--", "--yolo"], "/tmp/project", "boss_participant"));
  for (const arg of ["-sworkspace-write", "-anever", "-C/etc"]) {
    assert.throws(() => assertHardenedBossCoiLaunch([arg], "/tmp/project", "boss_reviewer"));
    assert.throws(() => assertHardenedBossCoiLaunch(["--", arg], "/tmp/project", "boss_reviewer"));
  }
  assert.deepEqual(assertHardenedBossCoiLaunch([], "/tmp/project", "boss_reviewer"), {});
  assert.deepEqual(
    assertHardenedBossCoiLaunch(["-s", "read-only", "-a", "untrusted"], "/tmp/project", "boss_reviewer"),
    { approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: false } },
  );
  assert.throws(
    () => assertHardenedBossCoiLaunch(["--sandbox=workspace-write"], "/tmp/project", "boss_participant"),
    /broker-owned assigned workspace authority/,
  );
});

test("built bridge returns provider authority unavailable before config or connect", () => {
  const agent = {
    id: "worker",
    name: "worker",
    cwd: "/tmp/project",
    bossClient: "boss_participant",
  };
  const unavailable = (error) => error?.code === "PROVIDER_AUTHORITY_UNAVAILABLE";
  assert.throws(() => new CodexBridgeDaemon({
    statePath: "/tmp/state",
    agents: [{ ...agent, sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp/project"], networkAccess: true } }],
  }), unavailable);
  assert.throws(() => new CodexBridgeDaemon({
    statePath: "/tmp/state",
    agents: [agent],
    appServer: { command: "/attacker/codex" },
  }), unavailable);
  assert.throws(() => new CodexBridgeDaemon({
    statePath: "/tmp/state",
    agents: [agent],
  }), unavailable);

  const reviewer = {
    id: "reviewer",
    name: "reviewer",
    cwd: "/tmp",
    bossClient: "boss_reviewer",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
  for (const field of ["args", "startDaemonArgs"]) {
    for (const argv of [
      ["app-server", "--sandbox=workspace-write"],
      ["app-server", "--", "-a=never"],
      ["app-server", "-C/etc"],
      ["app-server", "--", "-C/etc"],
    ]) {
      assert.throws(() => new CodexBridgeDaemon({
        statePath: "/tmp/state",
        agents: [reviewer],
        appServer: { [field]: argv },
      }), unavailable);
    }
  }
});

test("built protected entry points never execute hostile PATH Codex and ordinary explicit TUI remains available", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-provider-dist-"));
  const marker = join(dir, "executed");
  const hostile = join(dir, "codex");
  const explicit = join(dir, "explicit-codex");
  writeFileSync(hostile, `#!/bin/sh\nprintf hostile > '${marker}'\n`);
  writeFileSync(explicit, "#!/bin/sh\nprintf ordinary > \"$1\"\n");
  chmodSync(hostile, 0o755);
  chmodSync(explicit, 0o755);
  const hostileEnv = { ...process.env, PATH: dir, CODEX_INTERCOM_BOSS_CLIENT: "boss_reviewer" };
  const unavailable = (error) => error?.code === "PROVIDER_AUTHORITY_UNAVAILABLE";
  try {
    for (const options of [
      { cwd: dir, noTui: false, copyShortcut: false, codexCommand: "codex", codexArgs: ["--help"] },
      { cwd: dir, noTui: true, copyShortcut: false, codexCommand: "codex", codexArgs: [] },
      { cwd: dir, noTui: false, copyShortcut: false, codexCommand: "codex", codexArgs: [] },
    ]) {
      await assert.rejects(runCoi(options, hostileEnv), unavailable);
      assert.equal(existsSync(marker), false);
    }
    assert.throws(() => new CodexBridgeDaemon({
      statePath: join(dir, "state.json"),
      agents: [{ id: "reviewer", name: "reviewer", cwd: dir, bossClient: "boss_reviewer" }],
    }), unavailable);
    assert.equal(existsSync(marker), false);

    await assert.rejects(
      runInteractiveTui("codex", ["initial"], ["resume", "thread-1"], dir, undefined, undefined, undefined, "boss_reviewer", hostileEnv),
      (error) => error?.code === "PROVIDER_AUTHORITY_UNAVAILABLE",
    );
    assert.equal(existsSync(marker), false);
    assert.equal(await runInteractiveTui(explicit, [marker], [marker], dir), 0);
    assert.equal(readFileSync(marker, "utf8"), "ordinary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every relevant built entry contains the exact CX3 state-machine and roster closures", () => {
  const broker = readFileSync(new URL("../dist/broker.mjs", import.meta.url), "utf8");
  const clients = ["codex-server.mjs", "bridge-daemon.mjs", "coi.mjs"].map((name) => (
    readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8")
  ));
  assert.match(broker, /function bossControlReplayFrames/);
  assert.match(broker, /function bossControlAcceptedRecoveryFrames/);
  assert.match(broker, /for \(const frame of bossControlAcceptedRecoveryFrames\(result\)\)/);
  assert.match(broker, /recordAccepted\(key, fingerprint, deliveryId/);
  assert.match(broker, /recordAccepted\(scope, fingerprint, deliveryId\)/);
  assert.doesNotMatch(broker, /recordAccepted\(scope, fingerprint, deliveryId, ttlMs\)/);
  assert.match(broker, /var RECENT_DELIVERY_TTL_MS = 10 \* 60 \* 1e3/);
  assert.match(broker, /pruneRecentDeliveries\(now = Date\.now\(\)\)/);
  assert.match(broker, /expiresAt: Date\.now\(\) \+ RECENT_DELIVERY_TTL_MS/);
  assert.match(broker, /Boss control ledger was corrupt and quarantined/);
  assert.doesNotMatch(broker, /registrationKind:\s*["']ordinary["']/);
  for (const client of clients) {
    assert.match(client, /removeCorrelated\(idempotencyKey, messageId, deliveryId\)/);
    assert.match(client, /markAccepted\(idempotencyKey, messageId, deliveryId\)/);
    assert.match(client, /pending\.deliveryId !== deliveryId/);
    assert.doesNotMatch(client, /Duplicate Boss control acknowledgement/);
    assert.match(client, /bossControlKind\(brokerMessage\.envelope\)\.envelope/);
    assert.match(client, /Boss control outbox was corrupt and quarantined/);
    assert.match(client, /function exactBossRosterSession/);
    assert.match(client, /currentRole === "manager" \|\| currentRole === "controller"/);
    assert.match(client, /worker\.canonicalIdentity\.bossRunId === bossIdentity\.bossRunId/);
  }
});

test("built target list omits the unprotected restricted-client bundle", () => {
  const info = JSON.parse(readFileSync(new URL("../dist/build-info.json", import.meta.url), "utf8"));
  assert.deepEqual(info.targets, ["codex-server", "broker", "bridge-daemon", "coi"]);
  assert.equal(existsSync(new URL("../dist/boss-client.mjs", import.meta.url)), false);
});

test("built and packaged surfaces use the exact runtime Core peer without an embedded duplicate", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.peerDependencies["@ctliz/agent-intercom-core"], "0.2.0");
  assert.equal(
    packageJson.devDependencies["@ctliz/agent-intercom-core"],
    "0.2.0",
  );

  for (const name of ["codex-server.mjs", "broker.mjs", "bridge-daemon.mjs", "coi.mjs"]) {
    const built = readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8");
    assert.match(built, /from "@ctliz\/agent-intercom-core(?:\/[^"]+)?"/);
    assert.doesNotMatch(built, /node_modules\/@ctliz\/agent-intercom-core\//);
  }
});
