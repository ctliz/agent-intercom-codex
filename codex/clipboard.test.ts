import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildOsc52Sequence, copyTextToClipboard, copyTextToTerminalClipboard } from "./clipboard.ts";

async function readEventually(file: string, expected: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const contents = readFileSync(file, "utf8");
      if (contents === expected) return contents;
    } catch (error) {
      lastError = error;
    }
    await delay(10);
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out reading ${file}`);
}

test("copyTextToClipboard handles wl-copy helpers that daemonize", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-intercom-clipboard-"));
  const outFile = path.join(dir, "clipboard.txt");
  const helper = path.join(dir, "wl-copy");
  const previousPath = process.env.PATH;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const previousDisplay = process.env.DISPLAY;
  const previousOut = process.env.CODEX_INTERCOM_FAKE_CLIPBOARD_OUT;

  try {
    writeFileSync(helper, "#!/bin/sh\ncat > \"$CODEX_INTERCOM_FAKE_CLIPBOARD_OUT\"\n(sleep 3) &\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
    process.env.WAYLAND_DISPLAY = "wayland-test";
    delete process.env.DISPLAY;
    process.env.CODEX_INTERCOM_FAKE_CLIPBOARD_OUT = outFile;

    const start = Date.now();
    const result = await copyTextToClipboard("handoff text", {
      platform: "linux",
      env: process.env,
    });

    assert.deepEqual(result, { ok: true, method: "wl-copy" });
    assert.ok(Date.now() - start < 500, "wl-copy should not block on daemonized descendants");
    assert.equal(await readEventually(outFile, "handoff text"), "handoff text");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = previousWayland;
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
    if (previousOut === undefined) delete process.env.CODEX_INTERCOM_FAKE_CLIPBOARD_OUT;
    else process.env.CODEX_INTERCOM_FAKE_CLIPBOARD_OUT = previousOut;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copyTextToClipboard reports unavailable helpers without blocking", async () => {
  const result = await copyTextToClipboard("handoff text", {
    platform: "linux",
    env: { PATH: "" },
    timeoutMs: 250,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /clip\.exe|ENOENT/);
});

test("buildOsc52Sequence encodes text and wraps tmux passthrough", () => {
  const plain = buildOsc52Sequence("Intercom send ID: worker", {});
  assert.equal(plain, `\x1b]52;c;${Buffer.from("Intercom send ID: worker").toString("base64")}\x07`);

  const tmux = buildOsc52Sequence("worker", { TMUX: "/tmp/tmux" });
  assert.equal(tmux, `\x1bPtmux;\x1b\x1b]52;c;${Buffer.from("worker").toString("base64")}\x07\x1b\\`);
});

test("copyTextToTerminalClipboard writes OSC 52 and reports writer failures", () => {
  let written = "";
  assert.deepEqual(copyTextToTerminalClipboard("worker", (sequence) => {
    written = sequence;
  }, {}), { ok: true, method: "osc52" });
  assert.equal(written, buildOsc52Sequence("worker", {}));

  const failed = copyTextToTerminalClipboard("worker", () => {
    throw new Error("closed");
  }, {});
  assert.deepEqual(failed, { ok: false, error: "closed" });
});
