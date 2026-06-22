import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSolverEnv, inferSolverCwd, parseEnvText } from "../scripts/solver-env.mjs";

{
  const parsed = parseEnvText(`
    # comments are ignored
    TENGAN_SOLVER_BIN="~/TexasSolver/console_solver"
    TENGAN_SOLVER_PORT=7444
  `);
  assert.equal(parsed.TENGAN_SOLVER_BIN, path.join(os.homedir(), "TexasSolver", "console_solver"));
  assert.equal(parsed.TENGAN_SOLVER_PORT, "7444");
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tengan-env-test-"));
  const bin = path.join(dir, "console_solver");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  fs.mkdirSync(path.join(dir, "resources"));

  const env = buildSolverEnv({ PATH: "" }, { TENGAN_SOLVER_BIN: bin });
  assert.equal(env.TENGAN_SOLVER_BIN, bin);
  assert.equal(env.TENGAN_SOLVER_CWD, dir);
  assert.equal(env.TENGAN_SOLVER_PORT, "7333");
  assert.equal(inferSolverCwd(bin), dir);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tengan-env-test-"));
  const buildDir = path.join(dir, "build-wasm");
  fs.mkdirSync(buildDir, { recursive: true });
  const bin = path.join(buildDir, "console_solver.js");
  fs.writeFileSync(bin, "console.log('solver')\n");
  assert.equal(inferSolverCwd(bin), dir);
}

console.log("PASS solver env config");
