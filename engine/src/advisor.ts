// Advisor — routes a spot to the right engine:
//   preflop          -> instant chart lookup
//   flop / turn      -> instant GTO math (multi-street live solve is too slow)
//   river (seated)   -> Discounted-CFR solve for hero's action frequencies
// Always returns the instant math alongside any solver output.
import { SpotInfo } from "./spot.js";
import { spotMath, callFracOfPot, potOddsEquity } from "./gtomath.js";
import { preflopAdvice, Pos, toChartPos, expandRange, GENERIC_CONTINUE } from "./ranges.js";
import { RiverSolver, RiverSpot } from "./cfr.js";
import { cardStr, rankOf, suitOf, Combo } from "./cards.js";
import { handCategory, evaluate7 } from "./evaluator.js";

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

export function advise(spot: SpotInfo, opts?: { iterations?: number }): Recommendation {
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
    const adv = preflopAdvice(spot.heroCards[0], spot.heroCards[1], toChartPos(spot.heroPosition || "BTN"), facing, stackBB);
    // Map the (possibly mixed) preflop strategy to action bars for the graph.
    const actions: ActionRec[] = adv.options.map((o) => ({
      kind: o.action === "allin" ? "raise" : o.action,
      freq: o.freq,
      allin: o.action === "allin",
      sizeBB: o.action === "raise" ? o.sizeBB : undefined
    }));
    return {
      headline: "", source: "chart", detail: adv.rationale, bb: spot.bb,
      top: actions[0], actions,
      note: "Preflop chart."
    };
  }

  // ---- Postflop math (always) ----
  const betFrac = spot.toCall > 0
    ? callFracOfPot(spot.toCall, spot.pot - spot.toCall || spot.pot)
    : 0.66; // reference sizing when we're the one who can bet
  const math = spotMath(betFrac, spot.effStack, spot.pot);

  // ---- River: real CFR solve for hero ----
  if (spot.street === "river" && spot.heroCards.length === 2) {
    try {
      const rec = solveRiver(spot, opts?.iterations ?? 400);
      return { ...rec, math };
    } catch (e: any) {
      return {
        headline: "math only", source: "math",
        detail: "River solve failed: " + (e?.message || e),
        math
      };
    }
  }

  // ---- Flop / turn: concrete hand-strength + pot-odds heuristic ----
  return flopTurnAdvice(spot, math);
}

// Polar, GTO-shaped flop/turn thresholds + bet sizes.
const POSTFLOP = {
  valueEq: 0.58, valueMedSize: 0.50,
  valueBigEq: 0.72, valueBigSize: 0.75,
  semibluffFreq: 0.66, bluffFreq: 0.30, bluffSize: 0.75,
  raiseEq: 0.70, raiseSize: 0.75, callBuffer: 0.05
};

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
  const cfg = POSTFLOP;
  const all = [...spot.heroCards, ...spot.board];
  const draw = hasStrongDraw(all);
  const cat = handCategory(all).cat;   // 0 high card, 1 pair, 2 two pair, ...
  const madeShowdown = cat >= 1;       // a pair or better = some showdown value
  const pot = spot.pot;
  const bb = spot.bb;
  const villRange = expandRange(GENERIC_CONTINUE, [...spot.board, ...spot.heroCards]);
  const eq = heroEquity(spot.heroCards, spot.board, villRange, 1500);
  const eqPct = Math.round(eq * 100);

  const eff = spot.effStack;
  // If a sized bet/raise meets or exceeds the effective stack, it's an all-in.
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
  // Order a bet/check mix so the more frequent action is the headline.
  const mix = (betFrac: number, betFreq: number): { actions: ActionRec[]; top: ActionRec } => {
    const b = bet(betFrac, betFreq);
    const c = plain("check", 1 - betFreq);
    return betFreq >= 0.5 ? { actions: [b, c], top: b } : { actions: [c, b], top: c };
  };

  let actions: ActionRec[]; let top: ActionRec; let detail: string;

  if (spot.toCall > 0) {
    // ---- Facing a bet ----
    const betFrac = callFracOfPot(spot.toCall, pot - spot.toCall || pot);
    const need = potOddsEquity(betFrac);
    const needPct = Math.round(need * 100);
    const band = 0.03; // indifference window around the pot-odds threshold
    if (eq >= cfg.raiseEq) {
      top = raiseTo(cfg.raiseSize); actions = [top];
      detail = `~${eqPct}% equity — raise for value.`;
    } else if (eq >= need + band) {
      top = plain("call"); actions = [top];
      detail = `~${eqPct}% vs ${needPct}% needed — call.`;
    } else if (eq >= need - band) {
      // Bluff-catcher right at the indifference point: GTO is indifferent, so
      // show a call/fold mix graded by how far equity sits across the threshold.
      let callF = (eq - (need - band)) / (2 * band);
      callF = Math.max(0.05, Math.min(0.95, callF));
      const c = plain("call", callF); const f = plain("fold", 1 - callF);
      ({ actions, top } = callF >= 0.5 ? { actions: [c, f], top: c } : { actions: [f, c], top: f });
      detail = `~${eqPct}% ≈ ${needPct}% needed — marginal, mix call/fold.`;
    } else if (draw && eq >= need - cfg.callBuffer) {
      top = plain("call"); actions = [top];
      detail = `~${eqPct}% + draw — call.`;
    } else {
      top = plain("fold"); actions = [top];
      detail = `~${eqPct}% < ${needPct}% needed — fold.`;
    }
  } else {
    // ---- Checked to us (we may bet) ----
    if (eq >= cfg.valueBigEq) {
      top = bet(cfg.valueBigSize); actions = [top];
      detail = `~${eqPct}% equity — value bet (big).`;
    } else if (eq >= cfg.valueEq) {
      top = bet(cfg.valueMedSize); actions = [top];
      detail = `~${eqPct}% equity — value bet.`;
    } else if (draw && cfg.semibluffFreq > 0) {
      ({ actions, top } = mix(cfg.bluffSize, cfg.semibluffFreq));
      detail = `~${eqPct}% + draw — semi-bluff (mix).`;
    } else if (!madeShowdown && cfg.bluffFreq > 0) {
      ({ actions, top } = mix(cfg.bluffSize, cfg.bluffFreq));
      detail = `~${eqPct}% equity — bluff some, check some.`;
    } else {
      top = plain("check"); actions = [top];
      detail = madeShowdown
        ? `~${eqPct}% equity — showdown value, check.`
        : `~${eqPct}% equity — check.`;
    }
  }

  return { headline: "", source: "equity", detail, bb, top, actions, math };
}

function solveRiver(spot: SpotInfo, iterations: number): Recommendation {
  const heroIsOOP = spot.heroIsOOP;
  const heroPlayer: 0 | 1 = heroIsOOP ? 0 : 1;

  const heroCombo = { a: spot.heroCards[0], b: spot.heroCards[1], w: 1 };
  const villainRange = expandRange(GENERIC_CONTINUE, [...spot.board, spot.heroCards[0], spot.heroCards[1]]);

  // pot before any pending bet (the bet is modeled as villain's contribution)
  const potBeforeBet = spot.toCall > 0 ? Math.max(1, spot.pot - spot.toCall) : spot.pot;

  const rspot: RiverSpot = {
    board: spot.board,
    pot: potBeforeBet,
    effStack: Math.max(1, spot.effStack),
    oop: heroIsOOP ? [heroCombo] : villainRange,
    ip: heroIsOOP ? villainRange : [heroCombo],
    betSizes: [0.5, 1.0],
    raiseSizes: [1.0],
    raiseCap: 1,
    allowAllIn: true
  };

  // Root = hero's decision. If hero faces a bet, model villain's bet as their
  // contribution so hero's root options are fold/call/raise.
  const rootOpts = spot.toCall > 0
    ? {
        actor: heroPlayer,
        cOOP: heroIsOOP ? 0 : spot.toCall,
        cIP: heroIsOOP ? spot.toCall : 0,
        // Villain's bet is the opening bet (not a raise), so hero can still
        // raise/all-in over it.
        raises: 0,
        prevCheck: false
      }
    : { actor: heroPlayer, cOOP: 0, cIP: 0, raises: 0, prevCheck: false };

  const solver = new RiverSolver(rspot, rootOpts);
  const { exploitabilityPct } = solver.solve(iterations);
  const rs = solver.rootStrategy();

  // hero range has exactly one combo -> index 0
  const hero = rs.perCombo[0];
  const actions: ActionRec[] = rs.actions.map((act, k) => ({
    kind: act.kind,
    amount: act.amount,
    allin: act.allin,
    freq: hero ? hero.freqs[k] : 0
  }));
  actions.sort((a, b) => b.freq - a.freq);

  // The graph shows the true solved (GTO) frequencies; the headline is the
  // highest-frequency action.
  const top = actions[0];

  return {
    headline: "",
    source: "solver",
    detail: `Hero ${cardStr(spot.heroCards[0])}${cardStr(spot.heroCards[1])} on ${spot.board.map(cardStr).join(" ")} — DCFR over a generic villain range.`,
    actions,
    top,
    bb: spot.bb,
    exploitabilityPct: +exploitabilityPct.toFixed(2),
    note: "Villain range is a generic continuing range (no read). Single-street solve."
  };
}
