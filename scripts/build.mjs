// Cross-platform bundler using esbuild-wasm (no native binary, runs on any OS).
// Builds two bundles:
//   src/engine.bundle.js  — loaded as a content script (globalThis.TenganEngine)
//   src/engine.worker.js  — Web Worker entry for off-main-thread solving
import * as esbuild from "esbuild-wasm";

const builds = [
  { entryPoints: ["engine/src/index.ts"],  outfile: "src/engine.bundle.js" },
  { entryPoints: ["engine/src/worker.ts"], outfile: "src/engine.worker.js" }
];
const common = { bundle: true, format: "iife", logLevel: "info", target: "es2020" };

const watch = process.argv.includes("--watch");

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...common, ...b });
    await ctx.watch();
  }
  console.log("esbuild-wasm: watching engine/src → src/engine.bundle.js + engine.worker.js");
} else {
  for (const b of builds) {
    await esbuild.build({ ...common, ...b });
    console.log("Built " + b.outfile);
  }
}
