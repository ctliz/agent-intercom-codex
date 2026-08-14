import { chmod, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { buildBanner, computeRuntimeSourceSha256 } from "./build-info.mjs";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const sourceSha256 = await computeRuntimeSourceSha256();
const identity = (target) => ({
  packageName: packageJson.name,
  version: packageJson.version,
  target,
  sourceSha256,
});
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
};
const coreExternals = [
  "@ctliz/agent-intercom-core",
  "@ctliz/agent-intercom-core/*",
];
const outputs = [
  { entry: "codex/server.ts", outfile: "dist/codex-server.mjs", target: "codex-server", executable: true },
  { entry: "broker/broker.ts", outfile: "dist/broker.mjs", target: "broker", executable: false },
  { entry: "codex/bridge-daemon.ts", outfile: "dist/bridge-daemon.mjs", target: "bridge-daemon", executable: true },
  { entry: "codex/coi.ts", outfile: "dist/coi.mjs", target: "coi", executable: true, external: ["codex", "node-pty"] },
];

await Promise.all(outputs.map((output) => build({
  ...common,
  entryPoints: [output.entry],
  outfile: output.outfile,
  banner: { js: buildBanner(identity(output.target), output.executable ? "#!/usr/bin/env node" : "") },
  external: [...coreExternals, ...(output.external ?? [])],
})));

await writeFile("dist/build-info.json", `${JSON.stringify({
  schemaVersion: 1,
  package: packageJson.name,
  version: packageJson.version,
  sourceSha256,
  targets: outputs.map((output) => output.target),
}, null, 2)}\n`, { mode: 0o644 });

for (const output of outputs) {
  const built = await readFile(output.outfile, "utf8");
  if (!built.includes(sourceSha256) || !built.includes(`target=${output.target}`)) {
    throw new Error(`Built output omitted immutable identity: ${output.outfile}`);
  }
}

await Promise.all(outputs
  .filter((output) => output.executable)
  .map((output) => chmod(output.outfile, 0o755)));
