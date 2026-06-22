// Tengan local solve-server — wraps the bupticybee/TexasSolver console binary so
// the HUD can request full-depth postflop GTO solves (flop/turn/river) over HTTP
// on localhost. Runs on the user's own machine; no external deps (Node built-ins).
//
//   TENGAN_SOLVER_BIN   path to console_solver (native binary) OR a .js Emscripten
//                       wasm build (console_solver.js) — a .js BIN is run via node
//                       (see wasm/ for the no-native-binary build).
//   TENGAN_SOLVER_CWD   TexasSolver install dir that contains resources/ (default: dir of BIN)
//   TENGAN_SOLVER_PORT  default 7333
//
// POST /solve  { board, pot, effStack, oopRange, ipRange, accuracy?, maxIter?,
//                threads?,
//                tree?: { flop|turn|river: { bet:[%], raise:[%], donk:[%], allin } },
//                flopBet?, turnBet?, riverBet?  (legacy single-size fallback) }
//   -> the dumped strategy JSON (root = OOP's first action).
// GET  /        -> readiness health check.
import http from "http";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

function resolveBin(bin, env = process.env) {
  const isWasm = /\.(c?js|mjs)$/.test(bin);
  const mode = isWasm ? fs.constants.R_OK : fs.constants.X_OK;
  const tryAccess = (p) => {
    try {
      fs.accessSync(p, mode);
      return p;
    } catch (e) {
      return null;
    }
  };
  if (bin.includes("/") || bin.includes(path.sep)) return tryAccess(path.resolve(bin));
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const found = tryAccess(path.join(dir, bin));
    if (found) return found;
  }
  return null;
}

export function makeConfig(env = process.env) {
  const bin = env.TENGAN_SOLVER_BIN || "console_solver";
  const resolvedBin = resolveBin(bin, env);
  const cwd = env.TENGAN_SOLVER_CWD || path.dirname(resolvedBin || bin);
  return {
    bin,
    resolvedBin,
    cwd,
    port: parseInt(env.TENGAN_SOLVER_PORT || "7333", 10),
    binIsWasm: /\.(c?js|mjs)$/.test(bin)
  };
}

export function solverHealth(config = makeConfig()) {
  if (!config.resolvedBin) {
    return {
      ok: false,
      bin: config.bin,
      cwd: config.cwd,
      error: `solver binary not found: ${config.bin}`,
      hint: "Set TENGAN_SOLVER_BIN to TexasSolver console_solver, or build wasm/console_solver.js."
    };
  }
  try {
    fs.accessSync(config.cwd, fs.constants.R_OK);
  } catch (e) {
    return {
      ok: false,
      bin: config.resolvedBin,
      cwd: config.cwd,
      error: `solver cwd not readable: ${config.cwd}`,
      hint: "Set TENGAN_SOLVER_CWD to the TexasSolver install directory."
    };
  }
  const resources = path.join(config.cwd, "resources");
  try {
    fs.accessSync(resources, fs.constants.R_OK);
  } catch (e) {
    return {
      ok: false,
      bin: config.resolvedBin,
      cwd: config.cwd,
      error: `solver resources not found: ${resources}`,
      hint: "Set TENGAN_SOLVER_CWD to the directory that contains resources/."
    };
  }
  return {
    ok: true,
    bin: config.resolvedBin,
    cwd: config.cwd,
    backend: config.binIsWasm ? "wasm" : "native"
  };
}

// Emit set_bet_sizes lines for one player/street from a spec
// { bet:[..], raise:[..], donk:[..], allin:bool }. Sizes are % of pot.
// `donk` (a lead by OOP into the prior aggressor) is OOP-only in TexasSolver.
function streetSizeLines(p, street, spec) {
  const L = [];
  if (!spec) return L;
  if (spec.bet && spec.bet.length) L.push(`set_bet_sizes ${p},${street},bet,${spec.bet.join(",")}`);
  if (spec.raise && spec.raise.length) L.push(`set_bet_sizes ${p},${street},raise,${spec.raise.join(",")}`);
  if (p === "oop" && spec.donk && spec.donk.length) L.push(`set_bet_sizes ${p},${street},donk,${spec.donk.join(",")}`);
  if (spec.allin) L.push(`set_bet_sizes ${p},${street},allin`);
  return L;
}

function buildConfig(req, dumpPath) {
  const L = [
    "set_pot " + (req.pot || 6),
    "set_effective_stack " + (req.effStack || 100),
    "set_board " + req.board,
    "set_range_oop " + req.oopRange,
    "set_range_ip " + req.ipRange
  ];
  const tree = req.tree;
  for (const p of ["oop", "ip"]) {
    if (tree) {
      // Richer bet tree (multiple sizes / donk per street) from the client preset.
      L.push(...streetSizeLines(p, "flop", tree.flop));
      L.push(...streetSizeLines(p, "turn", tree.turn));
      L.push(...streetSizeLines(p, "river", tree.river));
    } else {
      // Legacy single-size default (one bet/street + a flop raise + allin).
      const f = (req.flopBet || 50), t = (req.turnBet || 60), r = (req.riverBet || 75);
      L.push(`set_bet_sizes ${p},flop,bet,${f}`); L.push(`set_bet_sizes ${p},flop,raise,60`); L.push(`set_bet_sizes ${p},flop,allin`);
      L.push(`set_bet_sizes ${p},turn,bet,${t}`); L.push(`set_bet_sizes ${p},turn,allin`);
      L.push(`set_bet_sizes ${p},river,bet,${r}`); L.push(`set_bet_sizes ${p},river,allin`);
    }
  }
  L.push("set_allin_threshold 0.67", "build_tree", "set_thread_num " + (req.threads || 4),
    "set_accuracy " + (req.accuracy || 0.5), "set_max_iteration " + (req.maxIter || 100),
    "set_print_interval 100", "set_use_isomorphism 1", "start_solve", "set_dump_rounds 1",
    "dump_result " + dumpPath);
  return L.join("\n") + "\n";
}

function solve(req, config = makeConfig()) {
  const health = solverHealth(config);
  if (!health.ok) {
    throw new Error(health.error + (health.hint ? ". " + health.hint : ""));
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tengan-solve-"));
  const cfgPath = path.join(tmp, "in.txt");
  const dumpPath = path.join(tmp, "out.json");
  fs.writeFileSync(cfgPath, buildConfig(req, dumpPath));
  const exe = config.binIsWasm ? process.execPath : config.resolvedBin;
  const argv = config.binIsWasm ? [config.resolvedBin, "-i", cfgPath] : ["-i", cfgPath];
  execFileSync(exe, argv, { cwd: config.cwd, stdio: "ignore", timeout: (req.timeoutMs || 60000) });
  const out = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  return out;
}

export function createServer(config = makeConfig()) {
  return http.createServer((rq, rs) => {
  rs.setHeader("Access-Control-Allow-Origin", "*");
  rs.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (rq.method === "OPTIONS") { rs.writeHead(204); rs.end(); return; }
  if (rq.method === "GET") {
    const health = solverHealth(config);
    rs.writeHead(health.ok ? 200 : 503, { "Content-Type": "application/json" });
    rs.end(JSON.stringify(health));
    return;
  }
  if (rq.method === "POST" && rq.url === "/solve") {
    let body = "";
    rq.on("data", (c) => { body += c; if (body.length > 1e6) rq.destroy(); });
    rq.on("end", () => {
      let req; try { req = JSON.parse(body); } catch (e) { rs.writeHead(400); rs.end('{"error":"bad json"}'); return; }
      const health = solverHealth(config);
      if (!health.ok) {
        rs.writeHead(503, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ error: health.error, hint: health.hint, bin: health.bin, cwd: health.cwd }));
        return;
      }
      const t0 = Date.now();
      try {
        const out = solve(req, config);
        rs.writeHead(200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ ms: Date.now() - t0, strategy: out }));
      } catch (e) {
        rs.writeHead(500, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
    return;
  }
  rs.writeHead(404); rs.end();
  });
}

function start() {
  const config = makeConfig();
  const server = createServer(config);
  server.listen(config.port, "127.0.0.1", () => {
    const health = solverHealth(config);
    console.log(`Tengan solve-server on http://127.0.0.1:${config.port}  (bin: ${config.bin}, cwd: ${config.cwd})`);
    if (!health.ok) console.log(`Solver not ready: ${health.error}${health.hint ? " — " + health.hint : ""}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
