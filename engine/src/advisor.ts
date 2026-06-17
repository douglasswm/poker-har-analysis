// Advisor — routes a spot to the right engine:
//   preflop          -> instant chart lookup
//   flop / turn      -> instant GTO math (multi-street live solve is too slow)
//   river (seated)   -> Discounted-CFR solve for hero's action frequencies
// Always returns the instant math alongside any solver output.
import { SpotInfo } from "./spot.js";
import { spotMath, callFracOfPot } from "./gtomath.js";
import { preflopAdvice, Pos, expandRange, GENERIC_CONTINUE } from "./ranges.js";
import { RiverSolver, RiverSpot } from "./cfr.js";
import { cardStr } from "./cards.js";

export interface Recommendation {
  headline: string;                 // e.g. "BET 0.75x pot (72%)" or "FOLD"
  source: "chart" | "solver" | "math";
  detail: string;
  actions?: { label: string; freq: number; ev?: number }[];
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
    const facing = spot.toCall > spot.bb ? "raise" : spot.toCall > 0 ? "limp" : "unopened";
    const adv = preflopAdvice(spot.heroCards[0], spot.heroCards[1], (spot.heroPosition || "BTN") as Pos, facing as any, stackBB);
    const shove = stackBB <= 20 && adv.action === "raise";
    const size = adv.sizeBB ? ` ${adv.sizeBB}bb` : "";
    return {
      headline: shove ? "ALL-IN" : `${adv.action.toUpperCase()}${size}`,
      source: "chart",
      detail: adv.rationale,
      note: "Preflop chart (6-max default ranges)."
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

  // ---- Flop / turn: math heuristic (no live multi-street solve) ----
  const facingBet = spot.toCall > 0;
  return {
    headline: facingBet
      ? `Defend ≥ ${math.mdfPct}% of range; need ${math.potOddsPct}% equity to call`
      : `Bet sizing reference; SPR ${math.spr}`,
    source: "math",
    detail: facingBet
      ? `Facing ~${(betFrac * 100).toFixed(0)}% pot. MDF ${math.mdfPct}%, pot odds ${math.potOddsPct}%.`
      : `Polarize big / merge small. Optimal bluff share at this size ≈ ${math.bluffPct}%.`,
    math,
    note: "Flop/turn live solving is out of scope (too slow); GTO math shown instead."
  };
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
  const actions = rs.actions.map((act, k) => ({
    label: labelFor(act, spot.pot),
    freq: hero ? hero.freqs[k] : 0
  }));
  actions.sort((a, b) => b.freq - a.freq);
  const top = actions[0];

  return {
    headline: top ? `${top.label.toUpperCase()} (${(top.freq * 100).toFixed(0)}%)` : "—",
    source: "solver",
    detail: `Hero ${cardStr(spot.heroCards[0])}${cardStr(spot.heroCards[1])} on ${spot.board.map(cardStr).join(" ")} — DCFR over a generic villain range.`,
    actions,
    exploitabilityPct: +exploitabilityPct.toFixed(2),
    note: "Villain range is a generic continuing range (no read). Single-street solve."
  };
}

function labelFor(act: { kind: string; amount: number; allin?: boolean }, pot: number): string {
  if (act.kind === "check") return "check";
  if (act.kind === "fold") return "fold";
  if (act.kind === "call") return "call";
  if (act.allin) return act.kind === "raise" ? "raise all-in" : "all-in";
  const frac = pot > 0 ? (act.amount / pot) : 0;
  return `${act.kind} ${frac.toFixed(2)}x pot`;
}
