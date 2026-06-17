// Preflop chart + range helpers. The RFI ranges below are reasonable 6-max
// defaults (not solver-exact); they give instant preflop guidance and seed
// approximate ranges for the postflop solver.
import { Combo, rankOf, suitOf, RANKS } from "./cards.js";

// 169-hand code, e.g. "AKs", "TT", "72o".
export function handCode(c1: number, c2: number): string {
  let r1 = rankOf(c1), r2 = rankOf(c2);
  const suited = suitOf(c1) === suitOf(c2);
  if (r1 < r2) { const t = r1; r1 = r2; r2 = t; }
  const hi = RANKS[r1], lo = RANKS[r2];
  if (r1 === r2) return hi + lo;          // pair, e.g. "TT"
  return hi + lo + (suited ? "s" : "o");
}

// Position keys for 6-max.
export type Pos = "UTG" | "MP" | "CO" | "BTN" | "SB" | "BB";

// RFI (raise-first-in) ranges per position. Compact, widely-taught defaults.
const RFI: Record<Pos, string[]> = {
  UTG: ["AA","KK","QQ","JJ","TT","99","88","77","AKs","AQs","AJs","ATs","KQs","KJs","QJs","JTs","AKo","AQo"],
  MP:  ["AA","KK","QQ","JJ","TT","99","88","77","66","55","AKs","AQs","AJs","ATs","A9s","KQs","KJs","KTs","QJs","QTs","JTs","T9s","98s","AKo","AQo","AJo","KQo"],
  CO:  ["AA","KK","QQ","JJ","TT","99","88","77","66","55","44","33","22","AKs","AQs","AJs","ATs","A9s","A8s","A7s","A6s","A5s","A4s","A3s","A2s","KQs","KJs","KTs","K9s","QJs","QTs","Q9s","JTs","J9s","T9s","98s","87s","76s","65s","AKo","AQo","AJo","ATo","KQo","KJo","QJo"],
  BTN: ["AA","KK","QQ","JJ","TT","99","88","77","66","55","44","33","22","AKs","AQs","AJs","ATs","A9s","A8s","A7s","A6s","A5s","A4s","A3s","A2s","KQs","KJs","KTs","K9s","K8s","K7s","K6s","K5s","QJs","QTs","Q9s","Q8s","JTs","J9s","J8s","T9s","T8s","98s","97s","87s","86s","76s","65s","54s","AKo","AQo","AJo","ATo","A9o","KQo","KJo","KTo","QJo","QTo","JTo","T9o"],
  SB:  ["AA","KK","QQ","JJ","TT","99","88","77","66","55","44","33","22","AKs","AQs","AJs","ATs","A9s","A8s","A7s","A6s","A5s","A4s","A3s","A2s","KQs","KJs","KTs","K9s","QJs","QTs","Q9s","JTs","J9s","T9s","98s","87s","76s","65s","AKo","AQo","AJo","ATo","KQo","KJo","QJo"],
  BB:  [] // BB defends by calling/3-betting vs a raise, handled separately
};

export interface PreflopAdvice {
  action: "raise" | "call" | "fold" | "check";
  sizeBB?: number;
  rationale: string;
}

// facing: "unopened" (RFI), "raise" (someone raised), "limp".
export function preflopAdvice(
  c1: number, c2: number, pos: Pos,
  facing: "unopened" | "raise" | "limp",
  stackBB: number = 100
): PreflopAdvice {
  const code = handCode(c1, c2);
  const inRange = (RFI[pos] || []).includes(code);

  // Short-stack: open-shoving / re-shoving dominates small raises.
  if (stackBB <= 20) {
    const premium = ["AA","KK","QQ","JJ","AKs","AKo","AQs"].includes(code);
    if (facing === "raise") {
      if (premium) return { action: "raise", rationale: `Short (${Math.round(stackBB)}bb): shove (all-in) ${code} over the raise.` };
      return { action: "fold", rationale: `${code} folds to a raise at ${Math.round(stackBB)}bb.` };
    }
    if (pos === "BB" && facing === "unopened") return { action: "check", rationale: "BB option." };
    if (inRange || premium) return { action: "raise", rationale: `Short (${Math.round(stackBB)}bb): open-shove (all-in) ${code}.` };
    return { action: "fold", rationale: `${code} below the ${pos} shoving range at ${Math.round(stackBB)}bb.` };
  }

  if (facing === "unopened") {
    if (pos === "BB") return { action: "check", rationale: "BB, folded to you — check your option." };
    if (inRange) return { action: "raise", sizeBB: pos === "SB" ? 3 : 2.5, rationale: `${code} is in the ${pos} RFI range.` };
    return { action: "fold", rationale: `${code} is below the ${pos} opening range.` };
  }
  if (facing === "raise") {
    // Very compact 3-bet/defend heuristic.
    const premium = ["AA","KK","QQ","AKs","AKo"].includes(code);
    const strong = RFI.CO.includes(code); // proxy for a decent continuing hand
    if (premium) return { action: "raise", sizeBB: 9, rationale: `${code} is a premium 3-bet for value.` };
    if (strong && (pos === "BTN" || pos === "BB" || pos === "CO")) return { action: "call", rationale: `${code} is a reasonable call/defend in ${pos}.` };
    return { action: "fold", rationale: `${code} folds to a raise from ${pos}.` };
  }
  // facing a limp
  if (inRange) return { action: "raise", sizeBB: 4, rationale: `Iso-raise ${code} over the limp.` };
  return { action: "fold", rationale: `${code} folds over a limp from ${pos}.` };
}

// Expand a set of hand codes into concrete combos, excluding board-blocked ones.
export function expandRange(codes: string[], board: number[]): Combo[] {
  const out: Combo[] = [];
  const boardSet = new Set(board);
  for (let a = 0; a < 52; a++) {
    if (boardSet.has(a)) continue;
    for (let b = a + 1; b < 52; b++) {
      if (boardSet.has(b)) continue;
      if (codes.includes(handCode(a, b))) out.push({ a, b, w: 1 });
    }
  }
  return out;
}

// A broad, generic "still-in-the-hand" range for seeding villain on later
// streets when we have no better read. ~Top 40% of hands.
export const GENERIC_CONTINUE: string[] = [
  ...RFI.BTN,
  "Q7s","Q6s","Q5s","J7s","T7s","96s","75s","64s","53s","43s",
  "A8o","A7o","K9o","K9s","Q9o","J9o","98o","T8o"
];
