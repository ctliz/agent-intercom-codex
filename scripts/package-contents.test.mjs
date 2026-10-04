import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url);

test("published package contains only the intended protected-provider source and artifact", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8"));
  const providerRules = manifest.files.filter((path) => path.replace(/^!/, "").startsWith("provider/"));

  assert.deepEqual(providerRules, [
    "provider/protected-service.ts",
    "provider/provider.mjs",
    "!provider/entry.ts",
  ]);
  assert.ok(manifest.files.includes("!scripts/build-protected-provider.mjs"));
  assert.equal(providerRules.some((path) => path.includes("*")), false);
  assert.ok(existsSync(new URL("provider/protected-service.ts", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/provider.mjs", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/entry.ts", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/protected-service.test.ts", repositoryRoot)));
});

test("bundled skill uses the correct MCP server and conditional checks", () => {
  const skill = readFileSync(new URL("skills/codex-intercom/SKILL.md", repositoryRoot), "utf8");
  assert.match(skill, /`codex-intercom` MCP server \(or its configured alias\)/);
  assert.match(skill, /For a known recipient, call `intercom_send` directly/);
  assert.match(skill, /as routine preflight checks/);
  assert.match(skill, /A standalone successful send does not require a pending\/identity\/status check or a resend/);
  assert.match(skill, /natural work boundaries when expecting a response or handling inbound messages/);
  assert.match(skill, /Wait for approval/);
  assert.doesNotMatch(skill, /Call `intercom_pending` before ending a coordination turn/);
});

test("protected provider is neither an executable nor an ordinary build entry", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8"));
  const ordinaryBuild = readFileSync(new URL("scripts/build.mjs", repositoryRoot), "utf8");

  assert.equal(manifest.main, "dist/codex-server.mjs");
  assert.equal(Object.values(manifest.bin).includes("provider/provider.mjs"), false);
  assert.doesNotMatch(ordinaryBuild, /protected-provider|provider\/provider\.mjs|provider\/entry\.ts/);
  assert.match(manifest.scripts.prepack, /build:protected-provider/);
  assert.equal(manifest.scripts.build, "node scripts/build.mjs");
});
