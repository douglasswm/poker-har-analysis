// Bundle entry — attaches the engine to the global scope so the extension's
// content script can call it directly. Built to ../src/engine.bundle.js.
import { buildSpot } from "./spot.js";
import { advise } from "./advisor.js";
import { riverRanges, solveCombos, rangeDiagnostics } from "./rangebuilder.js";
import { cardStr, rankOf, suitOf, RANKS, SUITS } from "./cards.js";
import { handCategory } from "./evaluator.js";
import { preflopGrid } from "./ranges.js";
import * as gtomath from "./gtomath.js";
import { extractNativeActions, nativeGridFromStrategy, nativeNodeForHero, nativeRecommendation } from "./native.js";

type RecOpts = { iterations?: number; turnIters?: number; solveTurn?: boolean; heroSeat?: number; heroCards?: number[]; heroRole?: "aggressor" | "caller"; villainPos?: string; potType?: "limped" | "srp" | "3bet"; heroContinued?: boolean; villainContinued?: boolean; heroBarrels?: number; villainBarrels?: number; preflopRaiseCount?: number; nativeCap?: number };

// Even-subsample a combo list to `max`, keeping the hero's exact combo.
function capCombos<T extends { a: number; b: number }>(cs: T[], max: number, keep: number[]): T[] {
  if (cs.length <= max) return cs;
  const out: T[] = [];
  const step = cs.length / max;
  for (let x = 0; x < cs.length; x += step) out.push(cs[Math.floor(x)]);
  const [a, b] = keep;
  if (!out.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))) {
    const hc = cs.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
    if (hc) out[0] = hc;
  }
  return out;
}

const TenganEngine = {
  version: "0.1.0",
  buildSpot,
  advise,
  cardStr,
  handCategory,   // {cat,name} for a 7-card hand (used for bluff classification)
  preflopGrid,    // 13x13 strategy matrix for a position/facing/stack
  gtomath,

  // Native TexasSolver response interpretation. The bridge/HUD and verification
  // scripts use the same path so real solver JSON becomes HUD actions reliably.
  nativeNodeForHero,
  extractNativeActions,
  nativeRecommendation,
  nativeGrid: nativeGridFromStrategy,
  // Convenience: from a raw GameState json + positions map -> recommendation.
  // opts may force a hero seat / supply hole cards, and set solve iterations.
  recommend(gs: any, positions: Record<number, string>, opts?: RecOpts) {
    const spot = buildSpot(gs, positions, { heroSeat: opts?.heroSeat, heroCards: opts?.heroCards, heroRole: opts?.heroRole, villainPos: opts?.villainPos, potType: opts?.potType, heroContinued: opts?.heroContinued, villainContinued: opts?.villainContinued, heroBarrels: opts?.heroBarrels, villainBarrels: opts?.villainBarrels, preflopRaiseCount: opts?.preflopRaiseCount });
    return { spot, recommendation: advise(spot, { iterations: opts?.iterations, turnIters: opts?.turnIters, solveTurn: opts?.solveTurn }) };
  },

  // Build a request for the native TexasSolver solve-server from a spot: the
  // board + both ranges (position/pot-type aware) + the metadata the client
  // needs to read the hero's node out of the returned tree. Pot/stack in bb.
  solverRequest(gs: any, positions: Record<number, string>, opts?: RecOpts) {
    const spot = buildSpot(gs, positions, { heroSeat: opts?.heroSeat, heroCards: opts?.heroCards, heroRole: opts?.heroRole, villainPos: opts?.villainPos, potType: opts?.potType, heroContinued: opts?.heroContinued, villainContinued: opts?.villainContinued, heroBarrels: opts?.heroBarrels, villainBarrels: opts?.villainBarrels, preflopRaiseCount: opts?.preflopRaiseCount });
    if (!spot.ok || spot.heroCards.length !== 2 || spot.activePlayers > 2 || spot.street === "preflop" || spot.street === "pre-deal") {
      return { ok: false, reason: spot.reason || "not a heads-up postflop spot" };
    }
    const tsCard = (id: number) => RANKS[rankOf(id)] + SUITS[suitOf(id)];
    const bb = spot.bb > 0 ? spot.bb : 1;
    // Flop solves from the preflop ranges (compact class-lists); turn/river feed
    // the flop/turn-narrowed *combo* ranges so the deep solve is accurate.
    let oopRange: string, ipRange: string;
    if (spot.street === "flop") {
      const { hero, vill } = riverRanges(spot);
      oopRange = (spot.heroIsOOP ? hero : vill).join(",");
      ipRange = (spot.heroIsOOP ? vill : hero).join(",");
    } else {
      let { oop, ip } = solveCombos(spot);
      const cap = opts?.nativeCap;
      if (cap && cap > 0) { oop = capCombos(oop, cap, spot.heroCards); ip = capCombos(ip, cap, spot.heroCards); }
      const ser = (cs: { a: number; b: number }[]) => cs.map((c) => tsCard(c.a) + tsCard(c.b)).join(",");
      oopRange = ser(oop);
      ipRange = ser(ip);
    }
    return {
      ok: true,
      board: spot.board.map(tsCard).join(","),
      pot: +(spot.pot / bb).toFixed(2),
      effStack: +(spot.effStack / bb).toFixed(2),
      oopRange,
      ipRange,
      heroIsOOP: spot.heroIsOOP,
      heroCards: spot.heroCards.slice(),
      heroCardStr: spot.heroCards.map(tsCard),
      toCall: spot.toCall,
      bb,
      street: spot.street,
      range: rangeDiagnostics(spot)
    };
  }
};

(globalThis as any).TenganEngine = TenganEngine;
export default TenganEngine;
