import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOLVER_ENV_PATH = path.join(REPO_ROOT, ".solver.env");
export const SOLVER_ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".solver.env.example");

export function parseEnvText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = expandHome(value);
  }
  return out;
}

export function loadSolverEnv(envPath = SOLVER_ENV_PATH) {
  if (!fs.existsSync(envPath)) return {};
  return parseEnvText(fs.readFileSync(envPath, "utf8"));
}

export function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function executable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function addIfFound(candidates, p) {
  if (!p) return;
  if (p.endsWith(".js")) {
    if (exists(p)) candidates.push(p);
    return;
  }
  if (executable(p)) candidates.push(p);
}

function scanTexasSolverDirs(base, candidates) {
  if (!exists(base)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/texassolver/i.test(ent.name)) continue;
    const dir = path.join(base, ent.name);
    addIfFound(candidates, path.join(dir, "console_solver"));
    addIfFound(candidates, path.join(dir, "build", "console_solver"));
    addIfFound(candidates, path.join(dir, "build-wasm", "console_solver.js"));
  }
}

export function findCandidateSolverBin() {
  const home = os.homedir();
  const candidates = [];
  [
    path.join(home, "TexasSolver", "console_solver"),
    path.join(home, "TexasSolver", "build", "console_solver"),
    path.join(home, "TexasSolver-wasm-src", "build-wasm", "console_solver.js"),
    path.join(home, "Downloads", "TexasSolver", "console_solver"),
    path.join(home, "Downloads", "TexasSolver-wasm-src", "build-wasm", "console_solver.js")
  ].forEach((p) => addIfFound(candidates, p));
  scanTexasSolverDirs(path.join(home, "Downloads"), candidates);
  scanTexasSolverDirs(home, candidates);
  return candidates[0] || null;
}

export function inferSolverCwd(bin) {
  const resolved = path.resolve(expandHome(bin));
  const dir = path.dirname(resolved);
  if (path.basename(dir) === "build-wasm") return path.dirname(dir);
  if (exists(path.join(dir, "resources"))) return dir;
  const parent = path.dirname(dir);
  if (exists(path.join(parent, "resources"))) return parent;
  return dir;
}

export function buildSolverEnv(baseEnv = process.env, fileEnv = loadSolverEnv()) {
  const env = { ...baseEnv, ...fileEnv };
  if (env.TENGAN_SOLVER_BIN) env.TENGAN_SOLVER_BIN = expandHome(env.TENGAN_SOLVER_BIN);
  if (env.TENGAN_SOLVER_CWD) env.TENGAN_SOLVER_CWD = expandHome(env.TENGAN_SOLVER_CWD);
  if (!env.TENGAN_SOLVER_BIN) {
    const found = findCandidateSolverBin();
    if (found) env.TENGAN_SOLVER_BIN = found;
  }
  if (env.TENGAN_SOLVER_BIN && !env.TENGAN_SOLVER_CWD) {
    env.TENGAN_SOLVER_CWD = inferSolverCwd(env.TENGAN_SOLVER_BIN);
  }
  if (!env.TENGAN_SOLVER_PORT) env.TENGAN_SOLVER_PORT = "7333";
  return env;
}
