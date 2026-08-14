import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHardenedBossCoiLaunch, buildCodexAppServerArgs, buildCoiTuiArgs, cleanupOldCoiStateFiles, createDefaultIdentity, deriveBridgeAgentRuntimeConfig, hasCodexHelpOrVersion, parseCoiArgs, resetCoiStateForFreshStart, resolveCoiResumeRequest, runCoi, runInteractiveTui, sanitizeSegment, splitCodexResumeArgs } from "./coi.ts";
import { filterAltIInput, TuiInputDecoder } from "./tui-input.ts";

test("sanitizeSegment keeps readable safe ids", () => {
  assert.equal(sanitizeSegment("Codex:Repo Main#123"), "codex:repo-main-123");
  assert.equal(sanitizeSegment(""), "codex");
});

test("createDefaultIdentity derives readable per-process defaults", () => {
  const identity = createDefaultIdentity({
    cwd: "/home/me/src/project",
    pid: 1234,
    gitRoot: "/home/me/src/project",
    branch: "main",
  });
  assert.match(identity.id, /^codex-project-main-[a-f0-9]{8}-1234$/);
  assert.equal(identity.name, "codex:project:main#1234");
});

test("parseCoiArgs consumes sidecar options and passes codex args through", () => {
  const parsed = parseCoiArgs([
    "--name", "worker",
    "--id=worker-1",
    "--no-tui",
    "--profile", "cliproxy",
    "-m", "gpt-test",
  ], {});

  assert.equal(parsed.name, "worker");
  assert.equal(parsed.id, "worker-1");
  assert.equal(parsed.noTui, true);
  assert.equal(parsed.copyShortcut, true);
  assert.deepEqual(parsed.codexArgs, ["--profile", "cliproxy", "-m", "gpt-test"]);
});

test("parseCoiArgs leaves everything after separator for codex", () => {
  const parsed = parseCoiArgs([
    "--intercom-name", "sidecar",
    "--",
    "--name", "not-sidecar",
  ], {});

  assert.equal(parsed.name, "sidecar");
  assert.deepEqual(parsed.codexArgs, ["--", "--name", "not-sidecar"]);
});

test("parseCoiArgs supports disabling the Alt+I terminal shortcut", () => {
  assert.equal(parseCoiArgs(["--no-intercom-shortcut"], {}).copyShortcut, false);
  assert.equal(parseCoiArgs([], { CODEX_INTERCOM_SHORTCUT: "off" }).copyShortcut, false);
  assert.equal(parseCoiArgs(["--intercom-shortcut"], { CODEX_INTERCOM_SHORTCUT: "off" }).copyShortcut, true);
});

test("splitCodexResumeArgs keeps options before the resumed thread id", () => {
  assert.deepEqual(splitCodexResumeArgs(["--profile", "cliproxy", "-m", "gpt-test", "hello there"]), {
    optionArgs: ["--profile", "cliproxy", "-m", "gpt-test"],
    promptArgs: ["hello there"],
    separatorPresent: false,
  });
});

test("splitCodexResumeArgs respects explicit separator", () => {
  assert.deepEqual(splitCodexResumeArgs(["--no-alt-screen", "--", "--literal-prompt"]), {
    optionArgs: ["--no-alt-screen"],
    promptArgs: ["--literal-prompt"],
    separatorPresent: true,
  });
});

test("explicit separator prevents a literal resume prompt from becoming a TUI subcommand", () => {
  assert.deepEqual(resolveCoiResumeRequest(["--", "resume", "attacker-thread"]), {
    optionArgs: [],
    promptArgs: ["resume", "attacker-thread"],
  });
});

test("resolveCoiResumeRequest reuses an explicitly requested Codex thread", () => {
  assert.deepEqual(resolveCoiResumeRequest(["--profile", "work", "resume", "thread-123", "continue this"]), {
    optionArgs: ["--profile", "work"],
    threadId: "thread-123",
    promptArgs: ["continue this"],
  });
});

test("buildCoiTuiArgs opens a fresh remote TUI without resuming an empty sidecar thread", () => {
  assert.deepEqual(buildCoiTuiArgs("unix:///tmp/coi.sock", ["--profile", "work"], "thread-sidecar", [], false), [
    "--remote", "unix:///tmp/coi.sock", "--profile", "work",
  ]);
  assert.deepEqual(buildCoiTuiArgs("unix:///tmp/coi.sock", [], "thread-requested", ["continue"], true), [
    "resume", "--remote", "unix:///tmp/coi.sock", "thread-requested", "--", "continue",
  ]);
});

test("TUI reconstruction preserves separator so prompt-shaped options cannot be promoted", () => {
  assert.deepEqual(buildCoiTuiArgs("unix:///tmp/coi.sock", ["--no-alt-screen"], "thread-1", ["--literal-prompt"], false), [
    "--remote", "unix:///tmp/coi.sock", "--no-alt-screen", "--", "--literal-prompt",
  ]);
  assert.equal(hasCodexHelpOrVersion(["--", "--help"]), false);
  assert.deepEqual(deriveBridgeAgentRuntimeConfig(["--", "--yolo"], "/tmp/project"), {});
});

test("buildCodexAppServerArgs forwards only app-server-compatible config options", () => {
  assert.deepEqual(
    buildCodexAppServerArgs([
      "--dangerously-bypass-approvals-and-sandbox",
      "--profile", "cliproxy",
      "-c", 'model_provider="cliproxy"',
      "--enable", "multi_agent",
      "hello there",
    ], "/tmp/coi.sock", {}),
    [
      "app-server",
      "-c", 'model_provider="cliproxy"',
      "--enable", "multi_agent",
      "--listen", "unix:///tmp/coi.sock",
    ],
  );
});

test("buildCodexAppServerArgs forwards managed worker identity to the MCP subprocess", () => {
  assert.deepEqual(
    buildCodexAppServerArgs([], "/tmp/coi.sock", {
      AGENT_INTERCOM_WORKER_ID: "worker-1",
      AGENT_INTERCOM_RUN_ID: "run-1",
      AGENT_INTERCOM_MANAGER_TARGET: "manager-1",
      AGENT_INTERCOM_OWNED: "1",
    }),
    [
      "app-server",
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_WORKER_ID="worker-1"',
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_RUN_ID="run-1"',
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_MANAGER_TARGET="manager-1"',
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_OWNED="1"',
      "--listen", "unix:///tmp/coi.sock",
    ],
  );
});

test("buildCodexAppServerArgs forwards canonical Boss identity without deriving it from legacy runId", () => {
  assert.deepEqual(
    buildCodexAppServerArgs([], "/tmp/coi.sock", {
      AGENT_INTERCOM_WORKER_ID: "worker-1",
      AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-1",
      AGENT_INTERCOM_WORKER_GENERATION: "2",
      AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
      AGENT_INTERCOM_PARTICIPANT_ID: "participant-1",
      AGENT_INTERCOM_BINDING_EPOCH: "3",
    }),
    [
      "app-server",
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_WORKER_ID="worker-1"',
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_WORKER_INCARNATION_ID="incarnation-1"',
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_WORKER_GENERATION="2"',
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_BOSS_RUN_ID="boss-run-1"',
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_PARTICIPANT_ID="participant-1"',
      "-c", 'mcp_servers.codex-intercom.env.AGENT_INTERCOM_BINDING_EPOCH="3"',
      "--listen", "unix:///tmp/coi.sock",
    ],
  );
});

test("filterAltIInput removes legacy and enhanced Alt+I press encodings", () => {
  assert.deepEqual(filterAltIInput("before\x1biafter\x1b[105;3:1u!"), {
    forwarded: "beforeafter!",
    pending: "",
    altICount: 2,
    altMCount: 0,
  });
  assert.deepEqual(filterAltIInput("\x1b[27;3;105~"), {
    forwarded: "",
    pending: "",
    altICount: 1,
    altMCount: 0,
  });
});

test("filterAltIInput consumes repeat and release events without retriggering", () => {
  assert.deepEqual(filterAltIInput("\x1b[105;3:1u\x1b[105;3:2u\x1b[105;3:3u"), {
    forwarded: "",
    pending: "",
    altICount: 1,
    altMCount: 0,
  });
});

test("filterAltIInput accepts lock modifiers and alternate keyboard layouts", () => {
  assert.deepEqual(filterAltIInput("\x1b[105;67u\x1b[1080::105;3u"), {
    forwarded: "",
    pending: "",
    altICount: 2,
    altMCount: 0,
  });
});

test("filterAltIInput preserves Alt+Shift+I and other modified keys", () => {
  const input = "\x1b[105;4u\x1b[105;7u\x1b[106;3u";
  assert.deepEqual(filterAltIInput(input), {
    forwarded: input,
    pending: "",
    altICount: 0,
    altMCount: 0,
  });
});

test("filterAltIInput carries split escape sequences between chunks", () => {
  const first = filterAltIInput("hello\x1b[105;");
  assert.deepEqual(first, { forwarded: "hello", pending: "\x1b[105;", altICount: 0, altMCount: 0 });
  assert.deepEqual(filterAltIInput("3:1uworld", first.pending), {
    forwarded: "world",
    pending: "",
    altICount: 1,
    altMCount: 0,
  });
});

test("filterAltIInput preserves unrelated terminal escape sequences", () => {
  assert.deepEqual(filterAltIInput("\x1b[A\x1b[200~paste\x1b[201~"), {
    forwarded: "\x1b[A\x1b[200~paste\x1b[201~",
    pending: "",
    altICount: 0,
    altMCount: 0,
  });
});

test("filterAltIInput also extracts Alt+M intercom shortcut encodings", () => {
  assert.deepEqual(filterAltIInput("before\x1bmafter\x1b[109;3:1u"), {
    forwarded: "beforeafter",
    pending: "",
    altICount: 0,
    altMCount: 2,
  });
});

test("TuiInputDecoder preserves UTF-8 split across terminal chunks", () => {
  const decoder = new TuiInputDecoder();
  const bytes = Buffer.from("a🙂b");
  const first = decoder.write(bytes.subarray(0, 3));
  const second = decoder.write(bytes.subarray(3));
  const ended = decoder.end();
  assert.equal(first.forwarded + second.forwarded + ended.forwarded, "a🙂b");
  assert.equal(first.altICount + second.altICount + ended.altICount, 0);
});

test("TuiInputDecoder carries and flushes partial escape sequences", () => {
  const decoder = new TuiInputDecoder();
  assert.deepEqual(decoder.write(Buffer.from("hello\x1b[105;")), { forwarded: "hello", altICount: 0, altMCount: 0 });
  assert.equal(decoder.hasPendingEscape(), true);
  assert.deepEqual(decoder.write(Buffer.from("3:1u")), { forwarded: "", altICount: 1, altMCount: 0 });
  assert.equal(decoder.hasPendingEscape(), false);
  decoder.write(Buffer.from("\x1b"));
  assert.equal(decoder.flushPendingEscape(), "\x1b");
});

test("hasCodexHelpOrVersion detects commands that should not force resume", () => {
  assert.equal(hasCodexHelpOrVersion(["--help"]), true);
  assert.equal(hasCodexHelpOrVersion(["--profile", "cliproxy"]), false);
});

test("deriveBridgeAgentRuntimeConfig carries workspace-write sandbox roots", () => {
  assert.deepEqual(deriveBridgeAgentRuntimeConfig([
    "--sandbox", "workspace-write",
    "--add-dir", "../shared",
    "--ask-for-approval=on-request",
  ], "/tmp/project"), {
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/tmp/project", "/tmp/shared"],
      networkAccess: false,
    },
  });
});

test("deriveBridgeAgentRuntimeConfig preserves omitted safe defaults", () => {
  assert.deepEqual(deriveBridgeAgentRuntimeConfig([], "/tmp/project"), {});
});

test("deriveBridgeAgentRuntimeConfig supports short and bypass flags", () => {
  assert.deepEqual(deriveBridgeAgentRuntimeConfig(["-s=read-only", "-a", "never"], "/tmp/project"), {
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });

  assert.deepEqual(deriveBridgeAgentRuntimeConfig(["--dangerously-bypass-approvals-and-sandbox"], "/tmp/project"), {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
});

test("hardened Boss launch rejects raw config, profiles, bypass aliases, and root expansion", () => {
  for (const args of [
    ["-c", "sandbox_mode=\"danger-full-access\""],
    ["--config=sandbox_mode=\"danger-full-access\""],
    ["-csandbox_mode=\"danger-full-access\""],
    ["-p", "unsafe-profile"],
    ["-punsafe-profile"],
    ["--profile=unsafe-profile"],
    ["--enable", "untrusted-feature"],
    ["--disable=approval_checks"],
    ["--dangerously-bypass-approvals-and-sandbox"],
    ["--dangerously-bypass-hook-trust"],
    ["--yolo"],
    ["--add-dir", "/tmp/outside"],
    ["-C", "/tmp/outside"],
  ]) {
    assert.throws(() => assertHardenedBossCoiLaunch(args, "/tmp/project", "boss_participant"));
  }
  for (const override of ["--yolo", "--config=unsafe", "--profile=unsafe", "--enable=escape", "--add-dir=/tmp/outside", "--sandbox=danger-full-access", "--ask-for-approval=never"]) {
    assert.throws(() => assertHardenedBossCoiLaunch(["--", override], "/tmp/project", "boss_participant"));
  }
});

test("hardened Boss launch rejects attached short authority options before TUI and refresh spawn", () => {
  for (const [arg, expected] of [
    ["-sworkspace-write", /attached -s policy override/],
    ["-anever", /attached -a policy override/],
    ["-C\/etc", /writable root/],
  ] as const) {
    for (const argv of [[arg], ["--", arg]]) {
      assert.throws(
        () => assertHardenedBossCoiLaunch(argv, "/tmp/project", "boss_reviewer"),
        expected,
        `must reject ${arg} in ${argv.join(" ")}`,
      );
    }
  }

  assert.deepEqual(assertHardenedBossCoiLaunch([], "/tmp/project", "boss_reviewer"), {});
  assert.deepEqual(
    assertHardenedBossCoiLaunch(["-s", "read-only", "-a", "untrusted"], "/tmp/project", "boss_reviewer"),
    { approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: false } },
  );
  assert.deepEqual(assertHardenedBossCoiLaunch(["-sworkspace-write", "-anever", "-C/etc"], "/tmp/project", undefined), {});
});

test("hardened Boss validation is proxy-first and zero-trap for raw argv", () => {
  let trapCount = 0;
  const proxy = new Proxy([], {
    get() { trapCount += 1; throw new Error("trap"); },
    ownKeys() { trapCount += 1; throw new Error("trap"); },
    getOwnPropertyDescriptor() { trapCount += 1; throw new Error("trap"); },
    getPrototypeOf() { trapCount += 1; throw new Error("trap"); },
  });
  assert.throws(() => assertHardenedBossCoiLaunch(proxy, "/tmp/project", "boss_participant"), /proxies are not supported/);
  assert.equal(trapCount, 0);
});

test("Boss production launch fails provider authority before help, args, or caller command inspection", async () => {
  const base = {
    cwd: "/tmp/project",
    noTui: true,
    copyShortcut: false,
    codexCommand: "codex",
    codexArgs: ["--help", "--yolo"],
  };
  for (const options of [base, { ...base, codexCommand: "/attacker/codex", codexArgs: ["--help"] }]) {
    await assert.rejects(
      runCoi(options, { CODEX_INTERCOM_BOSS_CLIENT: "boss_participant" }),
      (error: unknown) => (error as { code?: unknown }).code === "PROVIDER_AUTHORITY_UNAVAILABLE",
    );
  }
});

test("hostile PATH Codex is never executed by protected coi headless, help, TUI, or refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-provider-coi-"));
  const marker = join(dir, "executed");
  const executable = join(dir, "codex");
  writeFileSync(executable, `#!/bin/sh\nprintf hostile > '${marker}'\n`);
  chmodSync(executable, 0o755);
  const hostileEnv = { ...process.env, PATH: dir, CODEX_INTERCOM_BOSS_CLIENT: "boss_reviewer" };
  const failsUnavailable = (error: unknown) => (error as { code?: unknown }).code === "PROVIDER_AUTHORITY_UNAVAILABLE";
  try {
    const base = { cwd: dir, copyShortcut: false, codexCommand: "codex" };
    await assert.rejects(runCoi({ ...base, noTui: true, codexArgs: [] }, hostileEnv), failsUnavailable);
    await assert.rejects(runCoi({ ...base, noTui: false, codexArgs: ["--help"] }, hostileEnv), failsUnavailable);
    await assert.rejects(runCoi({ ...base, noTui: false, codexArgs: [] }, hostileEnv), failsUnavailable);
    await assert.rejects(
      runInteractiveTui("codex", ["initial"], ["resume", "thread-1"], dir, undefined, undefined, undefined, "boss_reviewer", hostileEnv),
      failsUnavailable,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary coi and TUI keep explicit executable launch behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-provider-ordinary-tui-"));
  const marker = join(dir, "executed");
  const executable = join(dir, "explicit-codex");
  writeFileSync(executable, `#!/bin/sh\nprintf ordinary > '${marker}'\n`);
  chmodSync(executable, 0o755);
  try {
    assert.equal(await runCoi({
      cwd: dir,
      noTui: false,
      copyShortcut: false,
      codexCommand: executable,
      codexArgs: ["--help"],
    }, { ...process.env, PATH: dir }), 0);
    assert.equal(existsSync(marker), true);
    rmSync(marker);
    assert.equal(await runInteractiveTui(executable, [], [], dir), 0);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hardened Boss launch preserves read-only reviewers and keeps writable participants dormant without root authority", () => {
  assert.throws(
    () => assertHardenedBossCoiLaunch(["--sandbox=workspace-write", "--ask-for-approval=untrusted"], "/tmp/project", "boss_participant"),
    /broker-owned assigned workspace authority/,
  );
  assert.deepEqual(
    assertHardenedBossCoiLaunch(["--sandbox=read-only", "--ask-for-approval=untrusted"], "/tmp/project", "boss_reviewer"),
    {
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
  );
  assert.throws(
    () => assertHardenedBossCoiLaunch(["--sandbox=workspace-write"], "/tmp/project", "boss_reviewer"),
    /read-only/,
  );
});

test("fresh worker startup removes the persisted Codex bridge thread state", () => {
  const dir = mkdtempSync(join(tmpdir(), "coi-fresh-start-"));
  try {
    const path = join(dir, "coi-state.json");
    writeFileSync(path, JSON.stringify({ agents: { worker: { threadId: "thread-old", updatedAt: 1 } } }));
    resetCoiStateForFreshStart(path, false);
    assert.equal(existsSync(path), true);
    resetCoiStateForFreshStart(path, true);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCoi fails closed for invalid scope before side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coi-scope-validation-"));
  try {
    const options = {
        cwd: dir,
        noTui: true,
        copyShortcut: false,
        codexCommand: "codex",
        codexArgs: [],
    };
    const env = { AGENT_INTERCOM_SCOPE_ID: "invalid scope!" };
    await assert.rejects(runCoi(options, env), /must match/);
    assert.equal(existsSync(join(dir, "intercom")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
