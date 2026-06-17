// Cross-platform test runner: bundle the TS engine test with esbuild-wasm, then
// run it with plain node. Avoids any native binary (tsx/esbuild) so it works on
// any OS with the same node_modules.
import * as esbuild from "esbuild-wasm";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const out = "engine/test/.run.bundle.cjs";
await esbuild.build({
  entryPoints: ["engine/test/run.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  target: "es2020",
  logLevel: "warning"
});

try {
  execFileSync(process.execPath, [out], { stdio: "inherit" });
} catch (e) {
  process.exit(e.status || 1);
}
