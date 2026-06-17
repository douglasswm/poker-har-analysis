// Test harness: evaluator ordering, GTO math values, and CFR convergence.
import { evaluate7 } from "../src/evaluator.js";
import { mdf, potOddsEquity, bluffFraction, alpha } from "../src/gtomath.js";
import { RiverSolver, RiverSpot } from "../src/cfr.js";
import { cardStr } from "../src/cards.js";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}
function approx(a: number, b: number, eps = 1e-6) { return Math.abs(a - b) < eps; }

// ---- 1. Evaluator ordering ----
// Royal flush (As Ks Qs Js Ts) vs a pair (Ac Ad + junk).
const id = (rank: number, suit: number) => rank * 4 + suit; // rank 0=2..12=A; suit 0c1d2h3s
const royal = evaluate7([id(12,3), id(11,3), id(10,3), id(9,3), id(8,3), id(0,0), id(1,1)]);
const pairAces = evaluate7([id(12,0), id(12,1), id(7,2), id(5,3), id(3,0), id(1,1), id(0,2)]);
const twoPair = evaluate7([id(12,0), id(12,1), id(11,2), id(11,3), id(3,0), id(1,1), id(0,2)]);
const flush = evaluate7([id(12,3), id(9,3), id(6,3), id(4,3), id(1,3), id(0,0), id(2,1)]);
check("royal flush > two pair", royal > twoPair);
check("two pair > pair of aces", twoPair > pairAces);
check("flush > two pair", flush > twoPair);
check("flush < royal flush", flush < royal);

// ---- 2. GTO math ----
check("MDF pot-bet = 50%", approx(mdf(1), 0.5));
check("MDF half-pot = 66.7%", approx(mdf(0.5), 2 / 3));
check("pot-odds half-pot = 25%", approx(potOddsEquity(0.5), 0.25));
check("bluff frac pot-bet = 1/3", approx(bluffFraction(1), 1 / 3));
check("alpha pot-bet = 50%", approx(alpha(1), 0.5));
check("MDF + alpha = 1", approx(mdf(0.75) + alpha(0.75), 1));

// ---- 3. CFR convergence on a polarized river ----
// Board: Kc Qd 7s 2h 9c (complete, no flush/straight).
const board = [id(11,0), id(10,1), id(5,3), id(0,2), id(7,0)];
// OOP: trips-9 (value) + 3s4s (pure air).
const oop = [
  { a: id(7,1), b: id(7,2), w: 1 },   // 9d 9h -> trips
  { a: id(1,3), b: id(2,3), w: 1 }    // 3s 4s -> air
];
// IP: bluff-catchers 55 and 66.
const ip = [
  { a: id(3,1), b: id(3,2), w: 1 },   // 5d 5h
  { a: id(4,1), b: id(4,2), w: 1 }    // 6d 6h
];
const spot: RiverSpot = {
  board, pot: 100, effStack: 100,
  oop, ip, betSizes: [1.0], raiseSizes: [], raiseCap: 0
};
const solver = new RiverSolver(spot);
const expl0 = solver.exploitability();
solver.solve(1500);
const expl1 = solver.exploitability();
console.log(`\nExploitability: ${expl0.toFixed(2)}% (start) -> ${expl1.toFixed(2)}% (after 1500 iters)`);
check("CFR exploitability converges < 3% of pot", expl1 < 3, `${expl1.toFixed(2)}%`);
check("CFR exploitability decreased", expl1 < expl0);

const rs = solver.rootStrategy();
console.log("\nRoot (OOP) average strategy:");
for (const pc of rs.perCombo) {
  const hand = cardStr(pc.combo.a) + cardStr(pc.combo.b);
  const parts = rs.actions.map((act, k) => {
    const lbl = act.kind === "check" ? "check" : `${act.kind}${act.amount}`;
    return `${lbl} ${(pc.freqs[k] * 100).toFixed(0)}%`;
  });
  console.log(`  ${hand}: ${parts.join("  ")}`);
}

// Sanity: the value hand (trips, combo 0) should bet more than the air hand bets
// at equilibrium (value bets near-always; air mixes).
const betIdx = rs.actions.findIndex((a) => a.kind === "bet");
if (betIdx >= 0) {
  const valueBet = rs.perCombo[0].freqs[betIdx];
  const airBet = rs.perCombo[1].freqs[betIdx];
  check("value hand bets more often than air", valueBet >= airBet, `value ${(valueBet*100).toFixed(0)}% vs air ${(airBet*100).toFixed(0)}%`);
  check("value hand bets frequently (>50%)", valueBet > 0.5, `${(valueBet*100).toFixed(0)}%`);
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED ✅" : failures + " TEST(S) FAILED ❌"}`);
process.exit(failures ? 1 : 0);
