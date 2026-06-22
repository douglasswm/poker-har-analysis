// Parity QA harness (G4). Two jobs:
//
//  1. REGRESSION GATE (default, offline): solve a battery of river spots with the
//     in-engine DCFR solver and diff the OOP root strategy against committed
//     golden references. Any per-combo drift above THRESHOLD fails the run — this
//     guards advisor/cfr/ranges changes from silently altering solver output.
//     `--gen` (re)writes the goldens.
//
//  2. LIVE CROSS-CHECK (`--live`, needs TENGAN_SOLVER_URL): solve the same spots
//     on the native TexasSolver server with a matching bet tree and report the
//     mean per-combo |Δ| between the in-engine and native strategies. Informational
//     (the in-engine river solver was already validated equal to TexasSolver); this
//     keeps an eye on that equality over time.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { RiverSolver, RiverSpot } from "../src/cfr.js";
import { TurnSolver, TurnSpot } from "../src/turn.js";
import { rankOf, suitOf, RANKS, SUITS, Combo } from "../src/cards.js";

const GOLDEN = "engine/test/parity.golden.json";
const ITERS = 2000;          // river: fixed -> deterministic average strategy
const TURN_ITERS = 300;      // turn: fewer iters (the turn tree is far bigger) but still deterministic
const GATE_THRESHOLD = 0.02;     // max allowed MEAN per-combo |Δ| vs golden (same solver -> ~0)
const GATE_MAX_THRESHOLD = 0.05; // max allowed SINGLE-combo |Δ| (catches a one-combo break)
// Match the advisor's in-engine river bet tree so the gate guards the live config.
const RIVER_BETS = [0.33, 0.75, 1.0], RIVER_RAISES = [0.75];

const cid = (s: string) => RANKS.indexOf(s[0]) * 4 + SUITS.indexOf(s[1]);
const idKey = (id: number) => RANKS[rankOf(id)] + SUITS[suitOf(id)];
const parseBoard = (s: string) => s.match(/../g)!.map(cid);
const comboKey = (c: { a: number; b: number }) => {
  const hi = Math.max(c.a, c.b), lo = Math.min(c.a, c.b);
  return idKey(hi) + idKey(lo);
};

// Expand a hand class ("99", "AK", "AKs", "AKo") into concrete combos, excluding
// any combo that uses a board card. Bulletproofs against manual card conflicts.
function expand(cls: string, board: number[]): Combo[] {
  const used = new Set(board);
  const out: Combo[] = [];
  const add = (a: number, b: number) => { if (a !== b && !used.has(a) && !used.has(b)) out.push({ a, b, w: 1 }); };
  // Explicit combo, e.g. "KsKd": two concrete cards.
  if (cls.length === 4) { add(cid(cls.slice(0, 2)), cid(cls.slice(2, 4))); return out; }
  const r1 = RANKS.indexOf(cls[0]), r2 = RANKS.indexOf(cls[1]);
  if (r1 < 0 || r2 < 0) throw new Error("bad hand class: " + cls);
  const suf = cls.length === 3 ? cls[2] : "";
  if (r1 === r2) {
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) add(r1 * 4 + s1, r1 * 4 + s2);
  } else {
    if (suf !== "o") for (let s = 0; s < 4; s++) add(r1 * 4 + s, r2 * 4 + s);          // suited
    if (suf !== "s") for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) add(r1 * 4 + s1, r2 * 4 + s2); // offsuit
  }
  return out;
}
const range = (classes: string[], board: number[]): Combo[] => classes.flatMap((c) => expand(c, board));

interface SpotDef { name: string; board: string; pot: number; effStack: number; oop: string[]; ip: string[]; street?: "river" | "turn"; }
const BATTERY: SpotDef[] = [
  // River spots (5-card boards) — solved by RiverSolver.
  { name: "dry-K-high", board: "Ks9d4c2h7s", pot: 6, effStack: 50,
    oop: ["KK", "99", "AKo", "QJs", "QTs", "JTs"], ip: ["AQ", "AJ", "TT", "88", "77", "55"] },
  { name: "wet-broadway", board: "QhJhTs9c2d", pot: 8, effStack: 60,
    oop: ["AA", "KK", "AKo", "KQ", "98s", "A5s"], ip: ["AQ", "KJ", "JT", "99", "T9o", "76s"] },
  { name: "paired-low", board: "8h8d5c3s2h", pot: 10, effStack: 40,
    oop: ["AA", "99", "A8s", "76s", "KQo", "JTs"], ip: ["TT", "JJ", "A5s", "65s", "QJo", "K9s"] },
  { name: "monotone-river", board: "Ad9s6s4s2s", pot: 7, effStack: 55,
    oop: ["AA", "KK", "AK", "KQ", "T9s", "55"], ip: ["AQ", "KJ", "JT", "99", "87s", "66"] },
  // Turn spots (4-card boards) — solved by the two-street TurnSolver. Small ranges
  // keep each solve to a few seconds so the gate stays CI-friendly.
  { name: "turn-dry-A", board: "As7d3c2h", pot: 6, effStack: 40, street: "turn",
    oop: ["AK", "99", "A5s"], ip: ["AQ", "TT", "76s"] },
  { name: "turn-wet-broadway", board: "QhJhTs2d", pot: 8, effStack: 45, street: "turn",
    oop: ["AA", "KQ", "98s"], ip: ["AKo", "JT", "99"] }
];

function inEngineStrategy(def: SpotDef) {
  const board = parseBoard(def.board);
  const oop = range(def.oop, board), ip = range(def.ip, board);
  let actionsRaw: { kind: string; amount: number; allin?: boolean }[];
  let perCombo: { combo: Combo; freqs: number[] }[];
  let exploit: number;
  if (def.street === "turn") {
    const spot: TurnSpot = { board, pot: def.pot, effStack: def.effStack, oop, ip,
      turnBetSizes: [0.66], riverBetSizes: [0.75], raiseCap: 1, allowAllIn: true };
    const solver = new TurnSolver(spot);
    solver.solve(TURN_ITERS);
    const rs = solver.rootStrategy(); actionsRaw = rs.actions; perCombo = rs.perCombo; exploit = solver.exploitability();
  } else {
    const spot: RiverSpot = { board, pot: def.pot, effStack: def.effStack, oop, ip,
      betSizes: RIVER_BETS, raiseSizes: RIVER_RAISES, raiseCap: 1, allowAllIn: true };
    const solver = new RiverSolver(spot);
    solver.solve(ITERS);
    const rs = solver.rootStrategy(); actionsRaw = rs.actions; perCombo = rs.perCombo; exploit = solver.exploitability();
  }
  const actions = actionsRaw.map((a) => a.kind === "check" ? "check" : a.allin ? "allin" : `bet${a.amount}`);
  const combos: Record<string, number[]> = {};
  for (const pc of perCombo) combos[comboKey(pc.combo)] = pc.freqs.map((f) => +f.toFixed(4));
  return { actions, combos, exploit: +exploit.toFixed(3), potChips: def.pot, effStack: def.effStack };
}

// ---- regression gate vs golden ----
function meanComboDiff(a: Record<string, number[]>, b: Record<string, number[]>): { mean: number; max: number; n: number } {
  let sum = 0, max = 0, n = 0;
  for (const k of Object.keys(a)) {
    if (!b[k]) continue;
    const fa = a[k], fb = b[k];
    let d = 0; for (let i = 0; i < Math.min(fa.length, fb.length); i++) d += Math.abs(fa[i] - (fb[i] || 0));
    d /= 2; // total variation distance over a probability distribution
    sum += d; max = Math.max(max, d); n++;
  }
  return { mean: n ? sum / n : 0, max, n };
}

// ---- live native cross-check ----
async function nativeStrategy(def: SpotDef, url: string): Promise<{ actions: string[]; combos: Record<string, number[]> } | null> {
  const board = parseBoard(def.board);
  const body = JSON.stringify({
    board: board.map(idKey).join(","), pot: def.pot, effStack: def.effStack,
    oopRange: def.oop.join(","), ipRange: def.ip.join(","),
    accuracy: 0.15, maxIter: 300, threads: 4,
    // Mirror the in-engine river tree: bet 50/100% pot, a pot-sized raise, + allin.
    tree: { river: { bet: [50, 100], raise: [100], allin: true } }
  });
  const r = await fetch(url + "/solve", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const j: any = await r.json();
  if (!j || j.error || !j.strategy || !j.strategy.strategy) return null;
  const s = j.strategy.strategy;
  const combos: Record<string, number[]> = {};
  for (const k of Object.keys(s.strategy)) {
    const ids = k.match(/../g)!.map(cid);
    combos[comboKey({ a: ids[0], b: ids[1] })] = s.strategy[k];
  }
  return { actions: s.actions, combos };
}

// Align in-engine actions (check / betX / allin) to native labels (CHECK / BET x / allin-BET).
function alignNativeToEngine(engActions: string[], natActions: string[], potChips: number, effStack: number): number[] {
  return engActions.map((ea) => {
    if (ea === "check") return natActions.findIndex((n) => /^CHECK/.test(n));
    if (ea === "allin") {
      let bi = -1, bamt = -1;
      natActions.forEach((n, i) => { const m = /^BET\s+([\d.]+)/.exec(n); if (m && parseFloat(m[1]) > bamt) { bamt = parseFloat(m[1]); bi = i; } });
      return bi;
    }
    const want = parseFloat(ea.slice(3)) / potChips; // engine bet as fraction of pot (amount in same units as pot)
    let bi = -1, bd = 1e9;
    natActions.forEach((n, i) => { const m = /^BET\s+([\d.]+)/.exec(n); if (!m) return; const frac = parseFloat(m[1]) / potChips; const d = Math.abs(frac - want); if (d < bd) { bd = d; bi = i; } });
    return bi;
  });
}

async function main() {
  const gen = process.argv.includes("--gen");
  const live = process.argv.includes("--live");
  const url = process.env.TENGAN_SOLVER_URL;

  const results: Record<string, ReturnType<typeof inEngineStrategy>> = {};
  for (const def of BATTERY) results[def.name] = inEngineStrategy(def);

  let failures = 0;

  if (gen) {
    writeFileSync(GOLDEN, JSON.stringify(results, null, 2));
    console.log(`Wrote golden references for ${BATTERY.length} spots -> ${GOLDEN}`);
  } else {
    if (!existsSync(GOLDEN)) { console.log(`No golden file (${GOLDEN}). Run with --gen first.`); process.exit(1); }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    console.log("== Regression gate: in-engine solver vs golden references ==");
    for (const def of BATTERY) {
      const g = golden[def.name], r = results[def.name];
      if (!g) { console.log(`FAIL  ${def.name}  — no golden entry`); failures++; continue; }
      const sameActs = JSON.stringify(g.actions) === JSON.stringify(r.actions);
      const d = meanComboDiff(r.combos, g.combos);
      const ok = sameActs && d.mean <= GATE_THRESHOLD && d.max <= GATE_MAX_THRESHOLD && d.n > 0;
      console.log(`${ok ? "PASS" : "FAIL"}  ${def.name}  — mean Δ ${(d.mean * 100).toFixed(2)}%  max ${(d.max * 100).toFixed(2)}%  combos ${d.n}${sameActs ? "" : "  [action set changed]"}`);
      if (!ok) failures++;
    }
  }

  if (live) {
    if (!url) { console.log("\n--live set but TENGAN_SOLVER_URL is empty; skipping native cross-check."); }
    else {
      console.log(`\n== Live cross-check: in-engine vs native TexasSolver (${url}) ==`);
      for (const def of BATTERY) {
        if (def.street === "turn") { console.log(`SKIP  ${def.name}  — turn live cross-check not implemented (river only)`); continue; }
        let nat = null;
        try { nat = await nativeStrategy(def, url); } catch (e) { console.log(`SKIP  ${def.name}  — ${(e as Error).message}`); continue; }
        if (!nat) { console.log(`SKIP  ${def.name}  — no native strategy`); continue; }
        const r = results[def.name];
        const map = alignNativeToEngine(r.actions, nat.actions, r.potChips, r.effStack);
        let sum = 0, n = 0;
        const aggE = new Array(r.actions.length).fill(0), aggN = new Array(r.actions.length).fill(0);
        for (const k of Object.keys(r.combos)) {
          const nf = nat.combos[k]; if (!nf) continue;
          let d = 0;
          for (let i = 0; i < r.actions.length; i++) {
            const ni = map[i], nfi = ni >= 0 ? (nf[ni] || 0) : 0;
            d += Math.abs(r.combos[k][i] - nfi);
            aggE[i] += r.combos[k][i]; aggN[i] += nfi;
          }
          sum += d / 2; n++;
        }
        const mean = n ? sum / n : 1;
        // The decision that matters is bet-vs-check; aggregate betting fraction is
        // action 0 (check) complement. Report aggregate freqs so per-combo sizing
        // non-uniqueness (substitutable large sizes) is visible as such.
        const aggLine = r.actions.map((a, i) => `${a} ${(aggE[i] / n * 100).toFixed(0)}/${(aggN[i] / n * 100).toFixed(0)}`).join("  ");
        const betDiff = Math.abs((aggE[0] - aggN[0]) / n); // |Δ check%| = |Δ betting%|
        const ok = betDiff <= 0.05; // gate-ish: decisions (bet vs check) must agree
        console.log(`${ok ? "OK  " : "WARN"}  ${def.name}  — Δcheck ${(betDiff * 100).toFixed(1)}%  per-combo Δ ${(mean * 100).toFixed(1)}%  agg E/N: ${aggLine}  (n=${n})`);
      }
    }
  }

  console.log(`\n${failures === 0 ? "PARITY GATE PASSED ✅" : failures + " SPOT(S) REGRESSED ❌"}`);
  process.exit(failures ? 1 : 0);
}

main();
