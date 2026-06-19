// Tengan local solve-server — wraps the bupticybee/TexasSolver console binary so
// the HUD can request full-depth postflop GTO solves (flop/turn/river) over HTTP
// on localhost. Runs on the user's own machine; no external deps (Node built-ins).
//
//   TENGAN_SOLVER_BIN   path to console_solver (e.g. .../TexasSolver/console_solver)
//   TENGAN_SOLVER_CWD   TexasSolver install dir that contains resources/ (default: dir of BIN)
//   TENGAN_SOLVER_PORT  default 7333
//
// POST /solve  { board, pot, effStack, oopRange, ipRange,
//                flopBet?, turnBet?, riverBet?, accuracy?, maxIter? }
//   -> the dumped strategy JSON (root = OOP's first action).
// GET  /        -> { ok: true } health check.
import http from "http";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const BIN = process.env.TENGAN_SOLVER_BIN || "console_solver";
const CWD = process.env.TENGAN_SOLVER_CWD || path.dirname(BIN);
const PORT = parseInt(process.env.TENGAN_SOLVER_PORT || "7333", 10);

function buildConfig(req, dumpPath) {
  const f = (req.flopBet || 50), t = (req.turnBet || 60), r = (req.riverBet || 75);
  const L = [
    "set_pot " + (req.pot || 6),
    "set_effective_stack " + (req.effStack || 100),
    "set_board " + req.board,
    "set_range_oop " + req.oopRange,
    "set_range_ip " + req.ipRange
  ];
  for (const p of ["oop", "ip"]) {
    L.push(`set_bet_sizes ${p},flop,bet,${f}`); L.push(`set_bet_sizes ${p},flop,raise,60`); L.push(`set_bet_sizes ${p},flop,allin`);
    L.push(`set_bet_sizes ${p},turn,bet,${t}`); L.push(`set_bet_sizes ${p},turn,allin`);
    L.push(`set_bet_sizes ${p},river,bet,${r}`); L.push(`set_bet_sizes ${p},river,allin`);
  }
  L.push("set_allin_threshold 0.67", "build_tree", "set_thread_num " + (req.threads || 4),
    "set_accuracy " + (req.accuracy || 0.5), "set_max_iteration " + (req.maxIter || 100),
    "set_print_interval 100", "set_use_isomorphism 1", "start_solve", "set_dump_rounds 1",
    "dump_result " + dumpPath);
  return L.join("\n") + "\n";
}

function solve(req) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tengan-solve-"));
  const cfgPath = path.join(tmp, "in.txt");
  const dumpPath = path.join(tmp, "out.json");
  fs.writeFileSync(cfgPath, buildConfig(req, dumpPath));
  execFileSync(BIN, ["-i", cfgPath], { cwd: CWD, stdio: "ignore", timeout: (req.timeoutMs || 60000) });
  const out = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  return out;
}

const server = http.createServer((rq, rs) => {
  rs.setHeader("Access-Control-Allow-Origin", "*");
  rs.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (rq.method === "OPTIONS") { rs.writeHead(204); rs.end(); return; }
  if (rq.method === "GET") { rs.writeHead(200, { "Content-Type": "application/json" }); rs.end(JSON.stringify({ ok: true, bin: BIN })); return; }
  if (rq.method === "POST" && rq.url === "/solve") {
    let body = "";
    rq.on("data", (c) => { body += c; if (body.length > 1e6) rq.destroy(); });
    rq.on("end", () => {
      let req; try { req = JSON.parse(body); } catch (e) { rs.writeHead(400); rs.end('{"error":"bad json"}'); return; }
      const t0 = Date.now();
      try {
        const out = solve(req);
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Tengan solve-server on http://127.0.0.1:${PORT}  (bin: ${BIN}, cwd: ${CWD})`);
});
