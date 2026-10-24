// Bundles and runs an opt-in live test against a real Nextcloud (see e2e/README.md).
// Usage: node scripts/run-live.mjs e2e/live-e2e.ts
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = process.argv[2];
if (!entry) {
  console.error("Usage: node scripts/run-live.mjs <entry.ts>");
  process.exit(2);
}
const outdir = mkdtempSync(join(tmpdir(), "nyra-live-build-"));
const outfile = join(outdir, "bundle.cjs");
try {
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs", target: "node20", outfile,
    alias: { obsidian: resolve("e2e/obsidian-mock.ts") }, logLevel: "warning"
  });
  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
