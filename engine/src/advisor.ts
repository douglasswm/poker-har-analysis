// Advisor — routes a spot to the right engine:
//   preflop          -> instant chart lookup
//   flop / turn      -> instant GTO math (multi-street live solve is too slow)
//   river (seated)   -> Discounted-CFR solve for hero's action frequencies
// Always returns the instant math alongside any solver output.
import { SpotInfo } from "./spot.js";
import { spotMath, callFracOfPot, potOddsEquity } from "./gtomath.js";
import { preflopAdvice, Pos, toChartPos, rangeAtShift, expandRange, GENERIC_CONTINUE, GENERIC_CBET, GENERIC_CALL, THREEBET, THREEBET_CALL, handCode } from "./ranges.js";
import { rankOf, suitOf, Combo } from "./cards.js";
import { handCategory, evaluate7 } from "./evaluator.js";
import { RiverSolver } from "./cfr.js";
import { TurnSolver } from "./turn.js";

// Raw action sizing — the UI formats it as $ or bb (unit toggle).
export interface ActionRec {
  kind: string;            // check | fold | call | bet | raise
  freq: number;
  amount?: number;         // bet/raise size in chips (river solver / heuristic)
  sizeBB?: number;         // bet/raise "to" size in big blinds (preflop chart)
  potFrac?: number;        // bet/raise size as a fraction of pot (flop/turn)
  allin?: boolean;
}

// Strong draw = flush draw (4 to a suit) or open-ended straight draw.
function hasStrongDraw(cards: number[]): boolean {
  const suits = [0, 0, 0, 0];
  for (const c of cards) suits[suitOf(c)]++;
  if (suits.some((s) => s === 4)) return true;
  const rset = new Set(cards.map(rankOf));
  const ranks = [...rset];
  if (rset.has(12)) ranks.push(-1); // wheel ace
  ranks.sort((a, b) => a - b);
  let run = 1, best = 1;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] === ranks[i - 1] + 1) { run++; best = Math.max(best, run); }
    else if (ranks[i] !== ranks[i - 1]) run = 1;
  }
  return best >= 4; // 4-in-a-row = open-ended (made straights handled separately)
}

export interface Recommendation {
  headline: string;                 // text for non-sized messages (math/errors)
  source: "chart" | "solver" | "math" | "heuristic" | "equity";
  detail: string;
  actions?: ActionRec[];            // for the strategy graph
  top?: ActionRec;                  // the recommended action (UI builds headline)
  bb?: number;                      // big-blind chip value (for $/bb formatting)
  math?: ReturnType<typeof spotMath>;
  exploitabilityPct?: number;
  note?: string;
}

export function advise(spot: SpotInfo, opts?: { iterations?: number; turnIters?: number; solveTurn?: boolean }): Recommendation {
  if (!spot.ok) {
    return { headline: "—", source: "math", detail: spot.reason || "no spot" };
  }
  if (spot.heroCards.length !== 2) {
    return {
      headline: "Enter hole cards",
      source: "math",
      detail: `Seat ${spot.heroPosition || spot.heroSeat} has no visible cards — pick the two cards to get a recommendation.`
    };
  }

  const stackBB = spot.bb > 0 ? spot.effStack / spot.bb : 100;

  // ---- Preflop: instant chart (with short-stack shoves) ----
  if (spot.street === "preflop") {
    const facing = spot.toCall > spot.bb ? "raise" : "open";
    const adv = preflopAdvice(spot.heroCards[0], spot.heroCards[1], toChartPos(spot.heroPosition || "BTN"), facing, stackBB, spot.isTournament);
    // Map the (possibly mixed) preflop strategy to action bars for the graph.
    const actions: ActionRec[] = adv.options.map((o) => ({
      kind: o.action === "allin" ? "raise" : o.action,
      freq: o.freq,
      allin: o.action === "allin",
      sizeBB: o.action === "raise" ? o.sizeBB : undefined
    }));
    const pushFoldMode = spot.isTournament && stackBB <= 25;
    return {
      headline: "", source: "chart", detail: adv.rationale, bb: spot.bb,
      top: actions[0], actions,
      note: pushFoldMode ? `MTT push/fold · ${Math.round(stackBB)}bb` : "Preflop chart."
    };
  }

  // ---- Postflop math (always) ----
  const betFrac = spot.toCall > 0
    ? callFracOfPot(spot.toCall, spot.pot - spot.toCall || spot.pot)
    : 0.66; // reference sizing when we're the one who can bet
  const math = spotMath(betFrac, spot.effStack, spot.pot);

  // The CFR solver is heads-up. Multiway pots (3+ players still in) are not
  // truly solvable here (TexasSolver is HU too), so they use the heuristic with
  // an explicit "approximate" flag rather than a wrong HU solve.
  const headsUp = spot.activePlayers <= 2;

  // ---- River: true range-vs-range Discounted-CFR solve (heads-up only) ----
  if (spot.street === "river" && spot.heroCards.length === 2 && headsUp) {
    try { return { ...solveRiverRVR(spot, opts?.iterations ?? 500), math }; }
    catch (e) { return flopTurnAdvice(spot, math); }
  }

  // ---- Turn: true two-street CFR solve (heads-up, off-thread via opts.solveTurn) ----
  if (spot.street === "turn" && spot.heroCards.length === 2 && headsUp && opts?.solveTurn) {
    try { return { ...solveTurnRVR(spot, opts?.turnIters ?? 70), math }; }
    catch (e) { return flopTurnAdvice(spot, math); }
  }

  // ---- Flop: range-aware polar heuristic (a full-flop CFR is too slow in pure
  // JS for live use — that's the native-solver / WASM territory) ----
  return flopTurnAdvice(spot, math);
}

// Filter a range to hands that would *continue* (call a bet) on the prior
// board: a made hand (pair+) or a strong draw. A flop-call range is much
// stronger than a flop-defend range — this drops the folded-out air.
function narrowContinue(combos: Combo[], priorBoard: number[]): Combo[] {
  if (priorBoard.length < 3) return combos;
  const out = combos.filter((c) => {
    const all = [c.a, c.b, ...priorBoard];
    return handCategory(all).cat >= 1 || hasStrongDraw(all);
  });
  return out.length >= 8 ? out : combos; // never prune to a degenerate range
}

// Ensure hero's actual combo is present in a range (so the solver can read it).
function ensureCombo(combos: Combo[], cards: number[]): Combo[] {
  const [a, b] = cards;
  if (combos.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))) return combos;
  return combos.concat([{ a, b, w: 1 }]);
}

// Evenly subsample a range to `max` combos (keeping spread), always retaining
// `keep` (hero's actual combo) so the solve can read it back.
function capRange(combos: Combo[], max: number, keep?: number[]): Combo[] {
  if (combos.length <= max) return combos;
  const out: Combo[] = [];
  const step = combos.length / max;
  for (let x = 0; x < combos.length; x += step) out.push(combos[Math.floor(x)]);
  if (keep && keep.length === 2) {
    const has = out.some((c) => (c.a === keep[0] && c.b === keep[1]) || (c.a === keep[1] && c.b === keep[0]));
    if (!has) {
      const hc = combos.find((c) => (c.a === keep[0] && c.b === keep[1]) || (c.a === keep[1] && c.b === keep[0]));
      if (hc) out[0] = hc;
    }
  }
  return out;
}

// Range-builder v2 — construct hero + villain ranges from the actual preflop
// action: the aggressor's range is the *opening range for their seat* (tight
// from UTG, wide from the button), and 3-bet pots use much tighter, polarized
// ranges. Far more accurate than one generic range regardless of who raised
// from where. The caller holds a wide continuing range.
function riverRanges(spot: SpotInfo): { hero: string[]; vill: string[] } {
  const heroPos = toChartPos(spot.heroPosition || "BTN");
  const villPos = toChartPos(spot.villainPos || "BTN");
  const threeBet = spot.potType === "3bet";

  const aggrRange = (pos: Pos): string[] => threeBet ? THREEBET : rangeAtShift(pos, 0);
  const callRange = (): string[] => threeBet ? THREEBET_CALL : GENERIC_CALL;

  let hero: string[], vill: string[];
  if (spot.heroRole === "aggressor") { hero = aggrRange(heroPos); vill = callRange(); }
  else if (spot.heroRole === "caller") { hero = callRange(); vill = aggrRange(villPos); }
  else { hero = GENERIC_CONTINUE; vill = GENERIC_CONTINUE; }

  const code = handCode(spot.heroCards[0], spot.heroCards[1]);
  if (!hero.includes(code)) hero = [...hero, code]; // hero's range must contain hero's hand
  return { hero, vill };
}

// True GTO river: solve hero's full range vs villain's full range with DCFR,
// then read the equilibrium strategy for hero's actual hand.
function solveRiverRVR(spot: SpotInfo, iterations: number): Recommendation {
  const heroIsOOP = spot.heroIsOOP;
  const heroPlayer: 0 | 1 = heroIsOOP ? 0 : 1;
  const { hero, vill } = riverRanges(spot);
  const RIVER_CAP = 220;
  const priorBoard = spot.board.slice(0, spot.board.length - 1); // turn board (what they called on)
  let heroR = expandRange(hero, spot.board);
  let villR = expandRange(vill, spot.board);
  if (spot.heroContinued) heroR = narrowContinue(heroR, priorBoard);
  if (spot.villainContinued) villR = narrowContinue(villR, priorBoard);
  const heroRange = ensureCombo(capRange(heroR, RIVER_CAP, spot.heroCards), spot.heroCards);
  const villRange = capRange(villR, RIVER_CAP);
  const toCall = spot.toCall;
  const potBeforeBet = toCall > 0 ? Math.max(1, spot.pot - toCall) : spot.pot;

  const rspot = {
    board: spot.board, pot: potBeforeBet, effStack: Math.max(1, spot.effStack),
    oop: heroIsOOP ? heroRange : villRange,
    ip: heroIsOOP ? villRange : heroRange,
    betSizes: [0.5, 1.0], raiseSizes: [1.0], raiseCap: 1, allowAllIn: true
  };
  const rootOpts = toCall > 0
    ? { actor: heroPlayer, cOOP: heroIsOOP ? 0 : toCall, cIP: heroIsOOP ? toCall : 0, raises: 0, prevCheck: false }
    : { actor: heroPlayer, cOOP: 0, cIP: 0, raises: 0, prevCheck: !heroIsOOP };

  const solver = new RiverSolver(rspot, rootOpts);
  const { exploitabilityPct } = solver.solve(iterations);
  const rs = solver.rootStrategy();

  const [ha, hb] = spot.heroCards;
  const hc = rs.perCombo.find((pc) => (pc.combo.a === ha && pc.combo.b === hb) || (pc.combo.a === hb && pc.combo.b === ha));
  if (!hc) throw new Error("hero combo not in solved range");

  const actions: ActionRec[] = rs.actions
    .map((act, k) => ({ kind: act.kind, amount: act.amount || undefined, allin: act.allin, freq: hc.freqs[k] }))
    .filter((a) => (a.freq || 0) > 0.004)
    .sort((a, b) => (b.freq || 0) - (a.freq || 0));

  return {
    headline: "", source: "solver", bb: spot.bb,
    detail: `River GTO solve — range vs range.`,
    top: actions[0], actions,
    exploitabilityPct: +exploitabilityPct.toFixed(2),
    note: `True CFR solve · exploitability ${exploitabilityPct.toFixed(1)}%`
  };
}

// True turn+river CFR solve on bounded ranges (capped so pure-JS stays ~live).
function solveTurnRVR(spot: SpotInfo, iterations: number): Recommendation {
  const heroIsOOP = spot.heroIsOOP;
  const heroPlayer: 0 | 1 = heroIsOOP ? 0 : 1;
  const { hero, vill } = riverRanges(spot); // same role-based range classes
  // Cap range size so the (turn × ~44 rivers × river) tree stays tractable in
  // pure JS off-thread (~9-11s at 130). Full ranges (~185) would be ~20s — that
  // needs river-card isomorphism (the optimization TexasSolver uses) to speed up.
  const CAP = 130;
  const priorBoard = spot.board.slice(0, spot.board.length - 1); // flop (what they called on)
  let heroR = expandRange(hero, spot.board);
  let villR = expandRange(vill, spot.board);
  if (spot.heroContinued) heroR = narrowContinue(heroR, priorBoard);
  if (spot.villainContinued) villR = narrowContinue(villR, priorBoard);
  const heroRange = ensureCombo(capRange(heroR, CAP, spot.heroCards), spot.heroCards);
  const villRange = capRange(villR, CAP);
  const toCall = spot.toCall;
  const potBeforeBet = toCall > 0 ? Math.max(1, spot.pot - toCall) : spot.pot;

  const tspot = {
    board: spot.board, pot: potBeforeBet, effStack: Math.max(1, spot.effStack),
    oop: heroIsOOP ? heroRange : villRange,
    ip: heroIsOOP ? villRange : heroRange,
    turnBetSizes: [0.66], riverBetSizes: [0.75], raiseCap: 1, allowAllIn: true
  };
  const rootOpts = toCall > 0
    ? { actor: heroPlayer, cOOP: heroIsOOP ? 0 : toCall, cIP: heroIsOOP ? toCall : 0, raises: 0, prevCheck: false }
    : { actor: heroPlayer, cOOP: 0, cIP: 0, raises: 0, prevCheck: !heroIsOOP };

  const solver = new TurnSolver(tspot, rootOpts);
  const { exploitabilityPct } = solver.solve(iterations);
  const rs = solver.rootStrategy();
  const [ha, hb] = spot.heroCards;
  const hc = rs.perCombo.find((pc) => (pc.combo.a === ha && pc.combo.b === hb) || (pc.combo.a === hb && pc.combo.b === ha));
  if (!hc) throw new Error("hero combo not in turn range");

  const actions: ActionRec[] = rs.actions
    .map((act, k) => ({ kind: act.kind, amount: act.amount || undefined, allin: act.allin, freq: hc.freqs[k] }))
    .filter((a) => (a.freq || 0) > 0.004)
    .sort((a, b) => (b.freq || 0) - (a.freq || 0));

  return {
    headline: "", source: "solver", bb: spot.bb,
    detail: `Turn GTO solve — range vs range (2-street).`,
    top: actions[0], actions,
    exploitabilityPct: +exploitabilityPct.toFixed(2),
    note: `True CFR solve (turn+river) · exploit ${exploitabilityPct.toFixed(1)}%`
  };
}

// Board "wetness" 0 (dry) .. 1 (wet) from flush potential, straight
// connectivity, and broadway density. Drives c-bet sizing/frequency: dry boards
// favor high-frequency small range-bets; wet boards favor polar value+draws.
function boardWetness(board: number[]): number {
  const suits = [0, 0, 0, 0];
  for (const c of board) suits[suitOf(c)]++;
  const maxSuit = Math.max(...suits);
  let s = maxSuit >= 3 ? 0.45 : maxSuit === 2 ? 0.28 : 0;
  const ranks = [...new Set(board.map(rankOf))].sort((a, b) => a - b);
  for (let i = 0; i < ranks.length - 1; i++) if (ranks[i + 1] - ranks[i] <= 2) s += 0.18;
  if (board.filter((c) => rankOf(c) >= 8).length >= 2) s += 0.12; // two+ broadway
  return Math.min(1, s);
}

// Monte-Carlo equity: hero's win probability vs a villain range over the
// remaining runouts. Fast (~tens of ms) so it's instant in the HUD.
function heroEquity(hero: number[], board: number[], villRange: Combo[], samples: number): number {
  const need = 5 - board.length;            // cards still to come (flop=2, turn=1)
  if (need < 0 || !villRange.length) return 0.5;
  const used = new Set([...hero, ...board]);
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  let win = 0, tie = 0, n = 0;
  for (let s = 0; s < samples; s++) {
    const vc = villRange[(Math.random() * villRange.length) | 0];
    if (used.has(vc.a) || used.has(vc.b)) continue;
    const run: number[] = [];
    let guard = 0;
    while (run.length < need && guard < 200) {
      const c = deck[(Math.random() * deck.length) | 0];
      if (c === vc.a || c === vc.b || run.indexOf(c) >= 0) { guard++; continue; }
      run.push(c);
    }
    if (run.length < need) continue;
    const hs = evaluate7([hero[0], hero[1], ...board, ...run]);
    const vs = evaluate7([vc.a, vc.b, ...board, ...run]);
    if (hs > vs) win++; else if (hs === vs) tie++;
    n++;
  }
  return n ? (win + tie * 0.5) / n : 0.5;
}

// Flop/turn action driven by real equity vs an assumed range (multi-street CFR
// is too slow live). Outputs a concrete action with a Stake-style bet size.
// Polar, GTO-shaped flop/turn advice (single-street, no live multi-street solve).
// Instead of "bet whenever equity is decent", hero's hand gets a role:
//   VALUE        -> bet (pure), sized by strength.
//   SEMI-BLUFF   -> bet a *draw* at a frequency, check the rest (mixed).
//   BLUFF        -> bet pure air at a (low) frequency, check the rest (mixed).
//   MEDIUM       -> showdown value: check (pure). This is the K8-type hand the
//                   solver checks — too strong to bluff, too weak to value bet.
// Facing a bet: raise strong, call clear bluff-catchers, MIX call/fold when the
// hand is right at the pot-odds indifference point, fold the rest.
function flopTurnAdvice(spot: SpotInfo, math: ReturnType<typeof spotMath>): Recommendation {
  const all = [...spot.heroCards, ...spot.board];
  const isRiver = spot.street === "river";
  const draw = !isRiver && hasStrongDraw(all);   // no live draws on the river
  const cat = handCategory(all).cat;             // 0 high card, 1 pair, 2 two pair, ...
  const madeShowdown = cat >= 1;
  const pot = spot.pot, bb = spot.bb;
  const wet = boardWetness(spot.board);
  const dryness = 1 - wet;
  const spr = pot > 0 ? spot.effStack / pot : 10;
  const lowSPR = spr <= 4;
  const role = spot.heroRole;                    // 'aggressor' | 'caller' | undefined

  const eff = spot.effStack;
  const cap = (a: ActionRec): ActionRec => {
    if (eff > 0 && a.amount != null && a.amount >= eff) { a.amount = eff; a.allin = true; }
    return a;
  };
  const bet = (frac: number, freq = 1): ActionRec => cap({ kind: "bet", freq, potFrac: frac, amount: Math.round(frac * pot) });
  const raiseTo = (frac: number): ActionRec => {
    const potAfterCall = pot + spot.toCall;
    return cap({ kind: "raise", freq: 1, potFrac: frac, amount: spot.toCall + Math.round(frac * potAfterCall) });
  };
  const plain = (kind: string, freq = 1): ActionRec => ({ kind, freq });
  const mix = (betFrac: number, betFreq: number): { actions: ActionRec[]; top: ActionRec } => {
    const b = bet(betFrac, betFreq); const c = plain("check", 1 - betFreq);
    return betFreq >= 0.5 ? { actions: [b, c], top: b } : { actions: [c, b], top: c };
  };
  const eqVs = (codes: string[]) =>
    heroEquity(spot.heroCards, spot.board, expandRange(codes, [...spot.board, ...spot.heroCards]), 1500);

  let actions: ActionRec[]; let top: ActionRec; let detail: string;

  if (spot.toCall > 0) {
    // ---- Facing a bet: value-weighted villain range so we don't over-call ----
    const eq = eqVs(GENERIC_CBET);
    const eqPct = Math.round(eq * 100);
    const betFrac = callFracOfPot(spot.toCall, pot - spot.toCall || pot);
    const need = potOddsEquity(betFrac);
    const needPct = Math.round(need * 100);
    const band = 0.03;
    if (eq >= 0.70) {
      top = raiseTo(0.75); actions = [top];
      detail = `~${eqPct}% vs ${needPct}% — raise for value.`;
    } else if (eq >= need + band) {
      top = plain("call"); actions = [top];
      detail = `~${eqPct}% vs ${needPct}% needed — call.`;
    } else if (eq >= need - band) {
      let callF = (eq - (need - band)) / (2 * band);
      callF = Math.max(0.05, Math.min(0.95, callF));
      const c = plain("call", callF); const f = plain("fold", 1 - callF);
      ({ actions, top } = callF >= 0.5 ? { actions: [c, f], top: c } : { actions: [f, c], top: f });
      detail = `~${eqPct}% ≈ ${needPct}% needed — marginal, mix call/fold.`;
    } else if (draw && eq >= need) {
      top = plain("call"); actions = [top];
      detail = `~${eqPct}% + draw — call.`;
    } else {
      top = plain("fold"); actions = [top];
      detail = `~${eqPct}% < ${needPct}% needed — fold.`;
    }
  } else if (role === "caller") {
    // ---- Checked to us as the preflop CALLER: check to the raiser ----
    const eq = eqVs(GENERIC_CONTINUE);
    const eqPct = Math.round(eq * 100);
    if (eq >= 0.80 && !lowSPR) {
      ({ actions, top } = mix(0.5, 0.10 + 0.15 * wet));   // occasionally lead the strongest hands
      detail = `~${eqPct}% — mostly check to the raiser, lead some.`;
    } else {
      top = plain("check"); actions = [top];
      detail = `~${eqPct}% — check to the preflop raiser.`;
    }
  } else {
    // ---- Checked to us as the AGGRESSOR (or unknown): c-bet by texture & SPR ----
    const eq = eqVs(GENERIC_CONTINUE);
    const eqPct = Math.round(eq * 100);
    if (eq >= 0.72) {
      top = bet(wet > 0.5 ? 0.75 : 0.5); actions = [top];
      detail = `~${eqPct}% — value bet${wet > 0.5 ? " (big)" : ""}.`;
    } else if (eq >= 0.56) {
      top = bet(wet > 0.5 ? 0.6 : 0.4); actions = [top];
      detail = `~${eqPct}% — value bet.`;
    } else if (draw) {
      ({ actions, top } = mix(0.66, Math.min(0.9, 0.45 + 0.45 * wet)));
      detail = `~${eqPct}% + draw — semi-bluff (mix).`;
    } else if (!madeShowdown) {
      let bf = 0.33 * (0.6 + 0.9 * dryness);   // bluff more on dry boards
      if (lowSPR) bf *= 0.4;                    // don't bluff into commitment
      bf = Math.max(0, Math.min(0.85, bf));
      if (bf < 0.02) { top = plain("check"); actions = [top]; detail = `~${eqPct}% — check.`; }
      else { ({ actions, top } = mix(dryness > 0.5 ? 0.4 : 0.66, bf)); detail = `~${eqPct}% — bluff some, check some.`; }
    } else {
      if (!lowSPR && dryness > 0.5 && eq >= 0.5) {
        ({ actions, top } = mix(0.4, 0.5));
        detail = `~${eqPct}% — thin value / protection.`;
      } else {
        top = plain("check"); actions = [top];
        detail = `~${eqPct}% — showdown value, check.`;
      }
    }
  }

  const note = spot.activePlayers > 2
    ? `Multiway (${spot.activePlayers}-way) — approximate (heuristic, not a solve)`
    : (isRiver ? "Heuristic (river solve unavailable)" : "Heuristic (flop/turn — not a full solve)");
  return { headline: "", source: "equity", detail, bb, top, actions, math, note };
}
