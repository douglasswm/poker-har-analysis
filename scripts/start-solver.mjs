import { spawn } from "node:child_process";
import path from "node:path";
import { makeConfig, solverHealth } from "../solver-server/server.js";
import { buildSolverEnv, REPO_ROOT, SOLVER_ENV_PATH, SOLVER_ENV_EXAMPLE_PATH } from "./solver-env.mjs";

const args = new Set(process.argv.slice(2));

function usage() {
  console.log(`Usage:
  npm run solver
  npm run solver:start
  npm run solver:start -- --check

Config:
  ${SOLVER_ENV_PATH}

Create it from:
  ${SOLVER_ENV_EXAMPLE_PATH}`);
}

function failConfig(health) {
  console.error("Native solver is not configured.");
  console.error(health.error || "missing TENGAN_SOLVER_BIN");
  if (health.hint) console.error(health.hint);
  console.error("");
  console.error("One-time setup:");
  console.error("  1. Edit .solver.env with your TexasSolver paths.");
  console.error("  2. Run npm run solver");
  console.error("");
  console.error("Expected native release layout:");
  console.error("  TENGAN_SOLVER_BIN=/path/to/TexasSolver/console_solver");
  console.error("  TENGAN_SOLVER_CWD=/path/to/TexasSolver   # contains resources/");
}

if (args.has("--help") || args.has("-h")) {
  usage();
  process.exit(0);
}

const env = buildSolverEnv();
const config = makeConfig(env);
const health = solverHealth(config);

if (!health.ok) {
  failConfig(health);
  process.exit(1);
}

console.log(`Native solver config ready: ${health.backend} · ${health.bin}`);
console.log(`Resources: ${health.cwd}`);
console.log(`URL: http://127.0.0.1:${config.port}`);

if (args.has("--check")) process.exit(0);

const child = spawn(process.execPath, [path.join(REPO_ROOT, "solver-server/server.js")], {
  cwd: REPO_ROOT,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});
