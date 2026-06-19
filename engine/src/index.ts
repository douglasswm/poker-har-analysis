// Bundle entry — attaches the engine to the global scope so the extension's
// content script can call it directly. Built to ../src/engine.bundle.js.
import { buildSpot } from "./spot.js";
import { advise } from "./advisor.js";
import { cardStr } from "./cards.js";
import { handCategory } from "./evaluator.js";
import { preflopGrid } from "./ranges.js";
import * as gtomath from "./gtomath.js";

const TenganEngine = {
  version: "0.1.0",
  buildSpot,
  advise,
  cardStr,
  handCategory,   // {cat,name} for a 7-card hand (used for bluff classification)
  preflopGrid,    // 13x13 strategy matrix for a position/facing/stack
  gtomath,
  // Convenience: from a raw GameState json + positions map -> recommendation.
  // opts may force a hero seat / supply hole cards, and set solve iterations.
  recommend(
    gs: any,
    positions: Record<number, string>,
    opts?: { iterations?: number; turnIters?: number; solveTurn?: boolean; heroSeat?: number; heroCards?: number[]; heroRole?: "aggressor" | "caller"; villainPos?: string; potType?: "limped" | "srp" | "3bet"; heroContinued?: boolean; villainContinued?: boolean }
  ) {
    const spot = buildSpot(gs, positions, { heroSeat: opts?.heroSeat, heroCards: opts?.heroCards, heroRole: opts?.heroRole, villainPos: opts?.villainPos, potType: opts?.potType, heroContinued: opts?.heroContinued, villainContinued: opts?.villainContinued });
    return { spot, recommendation: advise(spot, { iterations: opts?.iterations, turnIters: opts?.turnIters, solveTurn: opts?.solveTurn }) };
  }
};

(globalThis as any).TenganEngine = TenganEngine;
export default TenganEngine;
