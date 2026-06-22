// Test harness: evaluator ordering, GTO math values, and CFR convergence.
import { evaluate7, handCategory } from "../src/evaluator.js";
import { mdf, potOddsEquity, bluffFraction, alpha } from "../src/gtomath.js";
import { RiverSolver, RiverSpot } from "../src/cfr.js";
import { cardStr } from "../src/cards.js";
import { solveCombos, advise } from "../src/advisor.js";
import { isoAdvice, rangeGrid } from "../src/ranges.js";

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

// ---- 4. Aggressor multi-barrel narrowing (G2 range accuracy) ----
// A villain who has barreled 2 streets should have a polarized range: value +
// draws + a bluff slice, with middle/bottom-pair give-ups dropped.
{
  const flop = [id(11, 3), id(7, 1), id(2, 0)]; // Ks 9d 4c
  const board4 = [...flop, id(0, 2)];           // turn 2h
  const heroCards = [id(12, 0), id(12, 1)];      // AA (hero's hand; villain range is what we test)
  const mkSpot = (villBarrels: number): any => ({
    ok: true, street: "turn", board: board4.slice(), heroCards: heroCards.slice(),
    heroIsOOP: true, heroRole: "caller", heroPosition: "BB", villainPos: "BTN",
    potType: "srp", activePlayers: 2, villainBarrels: villBarrels, villainContinued: false,
    heroContinued: false, pot: 10, toCall: 0, bb: 1, effStack: 100
  });
  const topB = Math.max(...flop.map((c) => Math.floor(c / 4)));
  const classify = (range: { a: number; b: number }[]) => {
    let value = 0, midpair = 0;
    for (const c of range) {
      const all = [c.a, c.b, ...flop];
      const counts = new Array(13).fill(0);
      for (const x of all) counts[Math.floor(x / 4)]++;
      let pr = -1;
      for (let r = 0; r < 13; r++) if (counts[r] >= 2) pr = r;
      const cat = handCategory(all).cat;
      if (cat >= 2 || (cat === 1 && pr >= topB)) value++;
      else if (cat === 1 && pr < topB) midpair++;
    }
    return { value, midpair, n: range.length };
  };
  const c0 = classify(solveCombos(mkSpot(0)).ip); // villain range, no narrowing
  const c2 = classify(solveCombos(mkSpot(2)).ip); // villain range, 2 barrels -> polarized
  console.log(`\nVillain range  (no barrel): ${c0.n} combos  value=${c0.value}  midpair=${c0.midpair}`);
  console.log(`Villain range (2 barrels): ${c2.n} combos  value=${c2.value}  midpair=${c2.midpair}`);
  check("2-barrel drops middle/bottom pairs", c2.midpair < c0.midpair * 0.5, `mid ${c0.midpair} -> ${c2.midpair}`);
  check("2-barrel keeps value hands", c2.value >= Math.min(c0.value, 4), `value ${c0.value} -> ${c2.value}`);
  check("2-barrel range is smaller (polarized)", c2.n < c0.n, `${c0.n} -> ${c2.n}`);
}

// ---- 5. Iso-raise over limpers (preflop engine) ----
{
  const iso = (code: string, pos: any, limp: number, stack = 100) => {
    const r1 = id(RNK(code[0]), 3);
    const suited = code.endsWith("s");
    const r2 = id(RNK(code[1]), suited ? 3 : 2);
    return isoAdvice(r1, r2, pos, limp, stack).options[0];
  };
  const RNK = (ch: string) => "23456789TJQKA".indexOf(ch);
  check("iso: AKo raises over 1 limper", iso("AKo", "BTN", 1).action === "raise" && iso("AKo", "BTN", 1).sizeBB === 4, JSON.stringify(iso("AKo", "BTN", 1)));
  check("iso: sizing scales with limpers (2 -> 5bb)", iso("AKo", "BTN", 2).sizeBB === 5);
  check("iso: 99 iso-raises (value)", iso("99", "UTG", 1).action === "raise");
  check("iso: 77 overlimps (set-mine)", iso("77", "BTN", 1).action === "call");
  check("iso: 65s overlimps from MP", iso("65s", "MP", 1).action === "call");
  check("iso: T9s overlimps (suited connector)", iso("T9s", "BTN", 1).action === "call");
  check("iso: JTs iso-raises (broadway)", iso("JTs", "BTN", 1).action === "raise");
  check("iso: 72o folds", iso("72o", "BTN", 1).action === "fold");
  check("iso: BB iso-raises AA", iso("AA", "BB", 2).action === "raise");
  check("iso: BB checks trash (free flop)", iso("72o", "BB", 3).action === "check");
  check("iso: deep stack does NOT jam over a limper", iso("KQo", "LJ", 1, 200).action === "raise" && !iso("KQo", "LJ", 1, 200).allin);
  check("iso: genuinely short (10bb) jams a value hand", !!iso("AKo", "BTN", 1, 10).allin || iso("AKo", "BTN", 1, 10).action === "allin");
}

// ---- 6. Multiway equity heuristic (postflop, 3+ players) ----
{
  const ST = "cdhs", RK = "23456789TJQKA";
  const c = (s: string) => RK.indexOf(s[0]) * 4 + ST.indexOf(s[1]);
  const mw = (cards: string, board: string, active: number, toCall = 0, pot = 20, heroStk = 200, maxOpp = 200): any => {
    const hc = cards.match(/../g)!.map(c), bd = board.match(/../g)!.map(c);
    const st = bd.length === 5 ? "river" : bd.length === 4 ? "turn" : "flop";
    return { ok: true, street: st, heroCards: hc, board: bd, pot, bb: 2, toCall, effStack: 10, heroStack: heroStk, maxOppStack: maxOpp, heroPosition: "CO", heroIsOOP: true, activePlayers: active, isTournament: false, ante: 0 };
  };
  const act = (sp: any) => advise(sp, {}).actions[0].kind;
  check("mw: AA overpair value-bets multiway", act(mw("AsAh", "Kd7c2s", 6)) === "bet");
  check("mw: TPTK value-bets 3-way", act(mw("AsKh", "Kd7c2s", 3)) === "bet");
  check("mw: air checks multiway (no bluff)", act(mw("Qd9h", "Kd7c2s", 7)) === "check");
  check("mw: 2nd pair checks multiway (pot control)", act(mw("As7h", "Kd7c2s", 5)) === "check");
  check("mw: set raises facing a bet multiway", act(mw("9d9h", "9sKd7c", 4, 10, 30)) === "raise");
  check("mw: weak pair folds vs bet multiway", act(mw("7d6h", "Kd7c2s", 6, 10, 30)) === "fold");
  check("mw: nut flush draw calls a bet on price", act(mw("AhJh", "Kh7h2s", 5, 8, 24)) === "call");
  // Sizing: a DEEP hero's value bet must not be mislabeled all-in just because a
  // short stack sits in the pot (effStack=10 here is the table min; hero has 200).
  {
    const a = advise(mw("AsAh", "Kd7c2s", 4, 0, 20, 200, 200), {}).actions[0];
    check("mw: deep hero value-bet is NOT all-in (sizing fix)", a.kind === "bet" && !a.allin, JSON.stringify(a));
  }
  {
    const a = advise(mw("9d9h", "9sKd7c", 4, 10, 30, 18, 200), {}).actions[0]; // hero short (18bb), pot 30bb
    check("mw: genuinely short hero can commit all-in", a.kind === "raise" || a.allin === true, JSON.stringify(a));
  }
}

// ---- 7. Postflop range grid (solved-range -> 13x13) ----
{
  const ST = "cdhs", RK = "23456789TJQKA";
  const c = (s: string) => RK.indexOf(s[0]) * 4 + ST.indexOf(s[1]);
  const g = rangeGrid(["check", "bet"], [
    { a: c("As"), b: c("Ks"), freqs: [1, 0] },   // AKs combo 1 -> check
    { a: c("Ah"), b: c("Kh"), freqs: [0, 1] },   // AKs combo 2 -> bet
    { a: c("Ad"), b: c("Ac"), freqs: [0, 1] }    // AA -> bet
  ]);
  const find = (code: string) => g.cells.find((x) => x.code === code)!;
  check("grid: 169 cells", g.cells.length === 169);
  const aks = find("AKs");
  const akCheck = (aks.options.find((o) => o.action === "check") || { freq: 0 }).freq;
  check("grid: AKs blends two combos ~50/50", Math.abs(akCheck - 0.5) < 0.01, `check=${akCheck}`);
  check("grid: AA in range, 72o out of range", find("AA").inRange && !find("72o").inRange);
  check("grid: AA bets (in range, single combo)", (find("AA").options.find((o) => o.action === "bet") || { freq: 0 }).freq > 0.99);
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED ✅" : failures + " TEST(S) FAILED ❌"}`);
process.exit(failures ? 1 : 0);
