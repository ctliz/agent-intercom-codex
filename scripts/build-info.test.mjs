import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBanner, buildIdentityLine, computeRuntimeSourceSha256 } from "./build-info.mjs";

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-build-info-"));
  await mkdir(join(root, "broker"));
  await mkdir(join(root, "codex"));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "broker", "client.ts"), "export const client = 1;\n");
  await writeFile(join(root, "broker", "client.test.ts"), "ignored test\n");
  await writeFile(join(root, "codex", "coi.ts"), "export const coi = 1;\n");
  for (const file of ["config.ts", "boss-control-outbox.ts", "durable-json.ts", "outbound-outbox.ts", "types.ts"]) {
    await writeFile(join(root, file), `${file}\n`);
  }
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "scripts", "build-info.mjs"), "build info\n");
  await writeFile(join(root, "scripts", "build.mjs"), "build\n");
  return root;
}

test("runtime source identity is deterministic and excludes test-only changes", async () => {
  const root = await sourceFixture();
  try {
    const first = await computeRuntimeSourceSha256(root);
    await writeFile(join(root, "broker", "client.test.ts"), "changed ignored test\n");
    assert.equal(await computeRuntimeSourceSha256(root), first);
    await writeFile(join(root, "codex", "coi.ts"), "export const coi = 2;\n");
    assert.notEqual(await computeRuntimeSourceSha256(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build banner emits a machine-searchable immutable identity before application startup", () => {
  const identity = {
    packageName: "@ctliz/agent-intercom-codex",
    version: "0.10.0",
    target: "coi",
    sourceSha256: "a".repeat(64),
  };
  assert.equal(buildIdentityLine(identity), `[agent-intercom-build] package=@ctliz/agent-intercom-codex version=0.10.0 target=coi sourceSha256=${"a".repeat(64)}`);
  const banner = buildBanner(identity, "#!/usr/bin/env node");
  assert.ok(banner.startsWith("#!/usr/bin/env node\n"));
  assert.match(banner, /target=coi/);
  assert.match(banner, /sourceSha256=a{64}/);
});
