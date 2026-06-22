// Advisor — routes a spot to the right engine:
//   preflop          -> instant chart lookup
//   flop / turn      -> instant GTO math (multi-street live solve is too slow)
//   river (seated)   -> Discounted-CFR solve for hero's action frequencies
// Always returns the instant math alongside any solver output.
import { SpotInfo } from "./spot.js";
import { spotMath, callFracOfPot, potOddsEquity } from "./gtomath.js";
import { preflopAdvice, isoAdvice, toChartPos, expandRange, GENERIC_CONTINUE, GENERIC_CBET, rangeGrid, RangeGrid } from "./ranges.js";
import { rankOf, suitOf, Combo } from "./cards.js";
import { handCategory, evaluate7 } from "./evaluator.js";
import { RiverSolver } from "./cfr.js";
import { TurnSolver } from "./turn.js";
import { buildPostflopRanges, capRange, ensureCombo, hasStrongDraw, RangeDiagnostics } from "./rangebuilder.js";

export { riverRanges, solveCombos } from "./rangebuilder.js";

// Raw action sizing — the UI formats it as $ or bb (unit toggle).
export interface ActionRec {
  kind: string;            // check | fold | call | bet | raise
  freq: number;
  amount?: number;         // bet/raise size in chips (river solver / heuristic)
  sizeBB?: number;         // bet/raise "to" size in big blinds (preflop chart)
  potFrac?: number;        // bet/raise size as a fraction of pot (flop/turn)
  allin?: boolean;
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
  rangeGrid?: RangeGrid;            // postflop: 13x13 solved-range strategy (HU only)
  solver?: {
    backend: "chart" | "heuristic" | "engine-cfr" | "native-texassolver" | "equity";
    status: "ready" | "fallback" | "timeout" | "unreachable" | "error";
    detail?: string;
  };
  range?: RangeDiagnostics;
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
  // Preflop jam-vs-raise is bounded by HERO's own stack, not the table minimum
  // (a lone short-stacked limper must not make a deep hero "jam").
  const preStackBB = spot.bb > 0 ? (spot.heroStack || spot.effStack) / spot.bb : 100;

  // ---- Preflop: instant chart (with short-stack shoves) ----
  if (spot.street === "preflop") {
    const chartPos = toChartPos(spot.heroPosition || "BTN");
    const raised = spot.preflopRaised ?? (spot.toCall > spot.bb);
    const raiseCount = spot.preflopRaiseCount || (raised ? 1 : 0);
    const limpers = spot.limpers || 0;
    // Limped pot (limpers in front, no raise): iso-raise for value, overlimp
    // speculative hands, fold trash. Otherwise the standard open / vs-raise chart.
    const adv = (!raised && limpers >= 1)
      ? isoAdvice(spot.heroCards[0], spot.heroCards[1], chartPos, limpers, preStackBB, spot.isTournament)
      : preflopAdvice(spot.heroCards[0], spot.heroCards[1], chartPos, raised ? (raiseCount >= 2 ? "reraise" : "raise") : "open", preStackBB, spot.isTournament);
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
      note: pushFoldMode ? `MTT push/fold · ${Math.round(stackBB)}bb` : (raiseCount >= 2 ? "Preflop chart · vs re-raise." : "Preflop chart."),
      solver: { backend: "chart", status: "ready" }
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

/// Build the 13x13 solved-range grid from a CFR root strategy (all combos).
function gridFromRoot(rs: { actions: { kind: string; amount: number; allin?: boolean }[]; perCombo: { combo: { a: number; b: number }; freqs: number[] }[] }): RangeGrid {
  const kinds = rs.actions.map((a) => (a.allin ? "allin" : a.kind));
  const combos = rs.perCombo.map((pc) => ({ a: pc.combo.a, b: pc.combo.b, freqs: pc.freqs }));
  return rangeGrid(kinds, combos);
}

// True GTO river: solve hero's full range vs villain's full range with DCFR,
// then read the equilibrium strategy for hero's actual hand.
function solveRiverRVR(spot: SpotInfo, iterations: number): Recommendation {
  const heroIsOOP = spot.heroIsOOP;
  const heroPlayer: 0 | 1 = heroIsOOP ? 0 : 1;
  const RIVER_CAP = 220;
  const built = buildPostflopRanges(spot); // position/pot ranges + continue & barrel narrowing
  const heroRange = ensureCombo(capRange(built.heroR, RIVER_CAP, spot.heroCards), spot.heroCards);
  const villRange = capRange(built.villR, RIVER_CAP);
  const toCall = spot.toCall;
  const potBeforeBet = toCall > 0 ? Math.max(1, spot.pot - toCall) : spot.pot;

  const rspot = {
    board: spot.board, pot: potBeforeBet, effStack: Math.max(1, spot.effStack),
    oop: heroIsOOP ? heroRange : villRange,
    ip: heroIsOOP ? villRange : heroRange,
    // Wider river bet tree (33/75/100% pot + a 75% raise + allin). The river solve
    // is instant, so the extra sizes are ~free and sharpen sizing — benched at
    // ~0.6s with exploitability ~0.01% (vs ~0.10% on the old 2-size tree).
    betSizes: [0.33, 0.75, 1.0], raiseSizes: [0.75], raiseCap: 1, allowAllIn: true
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
    rangeGrid: gridFromRoot(rs),
    note: `True CFR solve · exploitability ${exploitabilityPct.toFixed(1)}%`,
    solver: { backend: "engine-cfr", status: "ready", detail: "river" },
    range: built.diagnostics
  };
}

// True turn+river CFR solve on bounded ranges (capped so pure-JS stays ~live).
function solveTurnRVR(spot: SpotInfo, iterations: number): Recommendation {
  const heroIsOOP = spot.heroIsOOP;
  const heroPlayer: 0 | 1 = heroIsOOP ? 0 : 1;
  // Cap range size so the (turn × ~44 rivers × river) tree stays tractable in
  // pure JS off-thread (~9-11s at 130). Full ranges (~185) would be ~20s — that
  // needs river-card isomorphism (the optimization TexasSolver uses) to speed up.
  const CAP = 130;
  const built = buildPostflopRanges(spot); // position/pot ranges + continue & barrel narrowing
  const heroRange = ensureCombo(capRange(built.heroR, CAP, spot.heroCards), spot.heroCards);
  const villRange = capRange(built.villR, CAP);
  const toCall = spot.toCall;
  const potBeforeBet = toCall > 0 ? Math.max(1, spot.pot - toCall) : spot.pot;

  const tspot = {
    board: spot.board, pot: potBeforeBet, effStack: Math.max(1, spot.effStack),
    oop: heroIsOOP ? heroRange : villRange,
    ip: heroIsOOP ? villRange : heroRange,
    // Turn stays single-size: it's the latency-bound street in pure JS (the
    // turn×rivers×river tree), and benching showed a second turn/river size ~doubles
    // the solve (~8s -> ~13s). For richer turn sizing use the native/WASM path.
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
    rangeGrid: gridFromRoot(rs),
    note: `True CFR solve (turn+river) · exploit ${exploitabilityPct.toFixed(1)}%`,
    solver: { backend: "engine-cfr", status: "ready", detail: "turn+river" },
    range: built.diagnostics
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

// Monte-Carlo equity vs a FIELD of `nOpp` opponents (each an independent draw
// from villRange). Hero only wins the pot if its hand beats *every* opponent; a
// top tie splits. This is the multiway-correct equity — far lower than the
// heads-up number, which is exactly why value/bluff thresholds must change with
// the number of players.
function heroEquityField(hero: number[], board: number[], villRange: Combo[], nOpp: number, samples: number): number {
  const need = 5 - board.length;
  if (need < 0 || !villRange.length || nOpp < 1) return 0.5;
  const used0 = new Set([...hero, ...board]);
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!used0.has(c)) deck.push(c);
  let score = 0, n = 0;
  for (let s = 0; s < samples; s++) {
    const used = new Set(used0);
    const opps: Combo[] = [];
    let ok = true;
    for (let o = 0; o < nOpp; o++) {
      let vc: Combo | null = null;
      for (let tries = 0; tries < 16; tries++) {
        const cand = villRange[(Math.random() * villRange.length) | 0];
        if (!used.has(cand.a) && !used.has(cand.b)) { vc = cand; break; }
      }
      if (!vc) { ok = false; break; }
      used.add(vc.a); used.add(vc.b); opps.push(vc);
    }
    if (!ok) continue;
    const run: number[] = [];
    let guard = 0;
    while (run.length < need && guard < 400) {
      const c = deck[(Math.random() * deck.length) | 0];
      if (used.has(c) || run.indexOf(c) >= 0) { guard++; continue; }
      run.push(c); used.add(c);
    }
    if (run.length < need) continue;
    const hs = evaluate7([hero[0], hero[1], ...board, ...run]);
    let maxV = -1, tiesAtTop = 0;
    for (const vc of opps) {
      const vs = evaluate7([vc.a, vc.b, ...board, ...run]);
      if (vs > maxV) maxV = vs;
    }
    if (hs > maxV) score += 1;
    else if (hs === maxV) {
      for (const vc of opps) if (evaluate7([vc.a, vc.b, ...board, ...run]) === hs) tiesAtTop++;
      score += 1 / (tiesAtTop + 1);
    }
    n++;
  }
  return n ? score / n : 0.5;
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
  // Effective stack for sizing/commitment is hero-relative: hero can't bet more
  // than their own stack, and can't be called for more than the deepest opponent
  // holds. Using the table MINIMUM (spot.effStack) mislabeled normal bets as
  // "all-in" and undersized them whenever any short stack was in the pot.
  const heroStk = spot.heroStack && spot.heroStack > 0 ? spot.heroStack : spot.effStack;
  const oppMax = spot.maxOppStack && spot.maxOppStack > 0 ? spot.maxOppStack : spot.effStack;
  const commitStk = Math.min(heroStk, oppMax);   // most that can actually go in
  const spr = pot > 0 ? commitStk / pot : 10;
  const lowSPR = spr <= 4;
  const role = spot.heroRole;                    // 'aggressor' | 'caller' | undefined
  const headsUpRange = (spot.activePlayers || 2) <= 2 ? buildPostflopRanges(spot).diagnostics : undefined;

  const eff = heroStk;                           // hero physically can't bet beyond this
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

  // ---- Multiway (3+ players): equity vs the FIELD, not a heads-up range ----
  // The HU heuristic below would over-value hands; in a multiway pot the hand
  // must beat every opponent, so we drive off field equity relative to a fair
  // share (1/(N+1)). Value-bet only when clearly ahead of the field, bluff far
  // less (more players to fold out), and call on price + draws.
  const nOpp = Math.max(1, (spot.activePlayers || 2) - 1);
  if (nOpp >= 2) {
    const field = expandRange(GENERIC_CONTINUE, [...spot.board, ...spot.heroCards]);
    const eq = heroEquityField(spot.heroCards, spot.board, field, nOpp, 1200);
    const eqPct = Math.round(eq * 100);
    const fair = 1 / (nOpp + 1);
    const edge = eq / fair;                      // 1.0 = average share, 2.0 = double
    const wayN = nOpp + 1;
    if (spot.toCall > 0) {
      const betFrac = callFracOfPot(spot.toCall, pot - spot.toCall || pot);
      const need = potOddsEquity(betFrac);
      const needPct = Math.round(need * 100);
      if (eq >= 0.55 && edge >= 1.8) {           // clearly ahead of a multiway field -> raise value
        top = raiseTo(0.7); actions = [top];
        detail = `~${eqPct}% vs field (${wayN}-way) — raise for value.`;
      } else if (eq >= need + 0.02) {
        top = plain("call"); actions = [top];
        detail = `~${eqPct}% vs ${needPct}% needed (${wayN}-way) — call.`;
      } else if (draw && eq >= need * 0.85) {
        top = plain("call"); actions = [top];
        detail = `~${eqPct}% + draw (${wayN}-way) — call on odds.`;
      } else {
        top = plain("fold"); actions = [top];
        detail = `~${eqPct}% < ${needPct}% needed (${wayN}-way) — fold.`;
      }
    } else if (eq >= 0.50 && edge >= 1.8 && cat >= 1) {  // made hand, well ahead of the field
      top = bet(wet > 0.5 ? 0.66 : 0.5); actions = [top];
      detail = `~${eqPct}% vs field (${wayN}-way) — value bet.`;
    } else if (eq >= 0.38 && edge >= 1.5 && cat >= 1) {  // ahead with a made hand -> thin value/protect
      top = bet(0.5); actions = [top];
      detail = `~${eqPct}% vs field (${wayN}-way) — thin value / protection.`;
    } else if (draw) {                            // semi-bluff a draw, but less often multiway
      ({ actions, top } = mix(0.6, Math.min(0.55, 0.25 + 0.3 * wet)));
      detail = `~${eqPct}% + draw (${wayN}-way) — semi-bluff some.`;
    } else {                                      // pure bluffing multiway rarely works -> check
      top = plain("check"); actions = [top];
      detail = `~${eqPct}% vs field (${wayN}-way) — check (pot control, bluffs fold out few of ${nOpp}).`;
    }
    return {
      headline: "", source: "equity", detail, bb, top, actions, math,
      note: `Multiway (${wayN}-way) — equity vs ${nOpp} opponents (approximate, not a solve)`,
      solver: { backend: "equity", status: "fallback", detail: "multiway approximate" }
    };
  }

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
  return {
    headline: "", source: "equity", detail, bb, top, actions, math, note,
    solver: { backend: "heuristic", status: "fallback", detail: isRiver ? "river solve unavailable" : "heads-up postflop heuristic" },
    range: headsUpRange
  };
}
