import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildSolverEnv, REPO_ROOT } from "./solver-env.mjs";

const URL = "http://127.0.0.1:7333";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function health() {
  try {
    const res = await fetch(URL + "/");
    const body = await res.json().catch(() => ({}));
    return res.ok && body.ok !== false;
  } catch (e) {
    return false;
  }
}

async function ensureServer() {
  if (await health()) return null;
  const child = spawn(process.execPath, ["solver-server/server.js"], {
    cwd: REPO_ROOT,
    env: buildSolverEnv(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));
  for (let i = 0; i < 30; i++) {
    if (await health()) return child;
    await sleep(500);
    if (child.exitCode != null) break;
  }
  child.kill("SIGINT");
  throw new Error("native solver server did not become ready");
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fmtAction(a, bb) {
  if (a.allin) return "all-in";
  if (a.kind === "fold" || a.kind === "check" || a.kind === "call") return a.kind;
  if (a.amount != null) return `${a.kind} $${(a.amount / 100).toFixed(2)} (${(a.amount / bb).toFixed(1)}bb)`;
  return a.kind;
}

const body = {
  board: "Qs,Jh,2h",
  pot: 6,
  effStack: 100,
  oopRange: "AA",
  ipRange: "KK",
  maxIter: 1,
  accuracy: 1,
  threads: 1,
  tree: {
    flop: { bet: [50], raise: [60], allin: true },
    turn: { bet: [66], allin: true },
    river: { bet: [75], allin: true }
  }
};

const req = {
  heroIsOOP: true,
  heroCardStr: ["As", "Ah"],
  toCall: 0,
  bb: 2,
  pot: 6,
  effStack: 100,
  street: "flop",
  streetActions: [],
  range: { heroCombos: 6, villainCombos: 6, filters: [] }
};

let child = null;
try {
  child = await ensureServer();
  await import(pathToFileURL(`${REPO_ROOT}/src/engine.bundle.js`).href);
  const Engine = globalThis.TenganEngine;
  assert(Engine && Engine.nativeRecommendation, "engine bundle did not expose nativeRecommendation");

  const res = await fetch(URL + "/solve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  assert(res.ok && json.strategy, `native solve failed: ${json.error || res.status}`);

  const rec = Engine.nativeRecommendation(json.strategy, req, { bb: req.bb }, json.ms);
  assert(rec && rec.top && rec.actions && rec.actions.length, "native response did not produce HUD actions");
  assert(rec.solver && rec.solver.backend === "native-texassolver", "recommendation is not labeled native");
  assert(rec.rangeGrid && rec.rangeGrid.cells && rec.rangeGrid.cells.length === 169, "native response did not produce a 169-cell range grid");
  assert(rec.actions.every((a) => a.kind && Number.isFinite(a.freq)), "native actions are not displayable");

  const headline = `${fmtAction(rec.top, req.bb).toUpperCase()} (${Math.round(rec.top.freq * 100)}%)`;
  const rows = rec.actions.map((a) => `${fmtAction(a, req.bb)} ${Math.round(a.freq * 100)}%`).join(" / ");
  console.log(`HUD native headline: ${headline}`);
  console.log(`HUD native rows: ${rows}`);
  console.log(`HUD native note: ${rec.note}`);
  console.log(`HUD native range grid: ${rec.rangeGrid.cells.length} cells`);
} finally {
  if (child) {
    child.kill("SIGINT");
    await sleep(250);
  }
}
