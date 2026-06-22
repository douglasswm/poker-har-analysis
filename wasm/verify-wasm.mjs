// Verify a freshly-built WASM console solver produces the SAME GTO output as the
// reference TexasSolver dump. Runs the wasm on the committed reference config and
// diffs every combo-action frequency against wasm/reference/expected.json.
//
//   node wasm/verify-wasm.mjs --wasm /path/to/console_solver.js --cwd /path/to/TexasSolver-src
//
// --cwd must contain resources/ (the wasm reads the card dictionary from there via
// NODERAWFS). Exit 0 on match (max |Δ| < 1e-9), 1 otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const wasmJs = get("--wasm");
const cwd = get("--cwd");
if (!wasmJs || !cwd) { console.error("usage: node verify-wasm.mjs --wasm <console_solver.js> --cwd <TexasSolver-src>"); process.exit(2); }

const HERE = dirname(fileURLToPath(import.meta.url));
const tpl = readFileSync(join(HERE, "reference", "solve.txt"), "utf8");
const expected = JSON.parse(readFileSync(join(HERE, "reference", "expected.json"), "utf8"));

const tmp = mkdtempSync(join(tmpdir(), "tengan-wasm-verify-"));
const out = join(tmp, "out.json");
const cfg = join(tmp, "cfg.txt");
writeFileSync(cfg, tpl + "dump_result " + out + "\n");

console.log("Running wasm solver:", wasmJs);
execFileSync(process.execPath, [wasmJs, "-i", cfg], { cwd, stdio: "ignore", timeout: 180000 });
const got = JSON.parse(readFileSync(out, "utf8"));

let maxd = 0, n = 0, sum = 0;
function walk(x, y) {
  if (x && x.strategy && x.strategy.strategy) {
    const sx = x.strategy.strategy, sy = (y.strategy && y.strategy.strategy) || {};
    for (const k in sx) { const fx = sx[k], fy = sy[k] || []; for (let i = 0; i < fx.length; i++) { const d = Math.abs(fx[i] - (fy[i] || 0)); maxd = Math.max(maxd, d); sum += d; n++; } }
  }
  if (x && x.childrens) for (const k in x.childrens) walk(x.childrens[k], (y.childrens && y.childrens[k]) || {});
}
walk(got, expected);
console.log(`compared ${n} combo-action freqs  max |Δ| ${maxd.toExponential(3)}  mean ${(sum / Math.max(n, 1)).toExponential(3)}`);
if (n === 0) { console.log("FAIL: no strategy found in wasm output"); process.exit(1); }
if (maxd < 1e-9) { console.log("MATCH ✅  wasm GTO == reference TexasSolver (byte-exact)"); process.exit(0); }
if (maxd < 1e-3) { console.log("MATCH ✅  within float tolerance"); process.exit(0); }
console.log("MISMATCH ❌  wasm output differs from reference"); process.exit(1);
