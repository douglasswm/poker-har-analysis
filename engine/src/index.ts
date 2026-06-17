// Bundle entry — attaches the engine to the global scope so the extension's
// content script can call it directly. Built to ../src/engine.bundle.js.
import { buildSpot } from "./spot.js";
import { advise } from "./advisor.js";
import { cardStr } from "./cards.js";
import * as gtomath from "./gtomath.js";

const TenganEngine = {
  version: "0.1.0",
  buildSpot,
  advise,
  cardStr,
  gtomath,
  // Convenience: from a raw GameState json + positions map -> recommendation.
  // opts may force a hero seat / supply hole cards, and set solve iterations.
  recommend(
    gs: any,
    positions: Record<number, string>,
    opts?: { iterations?: number; heroSeat?: number; heroCards?: number[] }
  ) {
    const spot = buildSpot(gs, positions, { heroSeat: opts?.heroSeat, heroCards: opts?.heroCards });
    return { spot, recommendation: advise(spot, { iterations: opts?.iterations }) };
  }
};

(globalThis as any).TenganEngine = TenganEngine;
export default TenganEngine;
