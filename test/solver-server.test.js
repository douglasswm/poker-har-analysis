import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeConfig, solverHealth } from "../solver-server/server.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tengan-server-test-"));
}

{
  const cfg = makeConfig({ TENGAN_SOLVER_BIN: "definitely-not-a-solver", PATH: "" });
  const health = solverHealth(cfg);
  assert.equal(health.ok, false);
  assert.match(health.error, /solver binary not found/);
}

{
  const dir = tempDir();
  const bin = path.join(dir, "console_solver");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  const cfg = makeConfig({ TENGAN_SOLVER_BIN: bin, PATH: "" });
  const health = solverHealth(cfg);
  assert.equal(health.ok, false);
  assert.match(health.error, /solver resources not found/);
}

{
  const dir = tempDir();
  const bin = path.join(dir, "console_solver");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  fs.mkdirSync(path.join(dir, "resources"));
  const cfg = makeConfig({ TENGAN_SOLVER_BIN: bin, PATH: "" });
  const health = solverHealth(cfg);
  assert.equal(health.ok, true);
  assert.equal(health.backend, "native");
  assert.equal(health.bin, bin);
  assert.equal(health.cwd, dir);
}

{
  const dir = tempDir();
  const bin = path.join(dir, "console_solver.js");
  fs.writeFileSync(bin, "console.log('solver')\n");
  fs.mkdirSync(path.join(dir, "resources"));
  const cfg = makeConfig({ TENGAN_SOLVER_BIN: bin, PATH: "" });
  const health = solverHealth(cfg);
  assert.equal(health.ok, true);
  assert.equal(health.backend, "wasm");
}

console.log("PASS solver-server health preflight");
