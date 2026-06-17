// Cross-platform bundler using esbuild-wasm (no native binary, runs on any OS).
// Bundles the TypeScript engine into the extension's loadable engine.bundle.js.
import * as esbuild from "esbuild-wasm";

const options = {
  entryPoints: ["engine/src/index.ts"],
  bundle: true,
  format: "iife",
  outfile: "src/engine.bundle.js",
  logLevel: "info",
  target: "es2020"
};

const watch = process.argv.includes("--watch");

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("esbuild-wasm: watching engine/src → src/engine.bundle.js (Ctrl+C to stop)");
} else {
  await esbuild.build(options);
  console.log("Built src/engine.bundle.js");
}
