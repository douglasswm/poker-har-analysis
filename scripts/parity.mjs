// Parity QA runner: bundle the TS parity harness with esbuild-wasm, then run it
// with plain node (same approach as scripts/test.mjs). Flags pass through.
//
//   node scripts/parity.mjs            # gate in-engine solver vs golden refs
//   node scripts/parity.mjs --gen      # (re)generate the golden refs
//   TENGAN_SOLVER_URL=http://127.0.0.1:7333 node scripts/parity.mjs --live
//                                      # also cross-check vs the native server
import * as esbuild from "esbuild-wasm";
import { execFileSync } from "node:child_process";

const out = "engine/test/.parity.bundle.cjs";
await esbuild.build({
  entryPoints: ["engine/test/parity.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  target: "es2020",
  logLevel: "warning"
});

try {
  execFileSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (e) {
  process.exit(e.status || 1);
}
