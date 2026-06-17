// 7-card hand evaluator. Returns a comparable integer (higher = stronger).
// Not the fastest possible, but correct and dependency-free: it scores the best
// 5-of-7 by category + kickers. Sufficient for river solving over capped ranges.
import { rankOf, suitOf } from "./cards.js";

// Category weights (high bits), then up to 5 rank tiebreakers in base-16.
const CAT = {
  HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
  FLUSH: 5, FULL: 6, QUADS: 7, STRAIGHT_FLUSH: 8
};

function score5(ranks: number[], suits: number[]): number {
  // ranks: array of 5 rank indices (0..12). suits: 5 suit indices.
  const counts = new Array(13).fill(0);
  for (const r of ranks) counts[r]++;
  const isFlush = suits.every((s) => s === suits[0]);

  // Straight detection (A can be high or low). Build presence bitmask.
  let mask = 0;
  for (const r of ranks) mask |= 1 << r;
  let straightHigh = -1;
  // normal straights: 5 consecutive ranks
  for (let hi = 12; hi >= 4; hi--) {
    const need = (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3)) | (1 << (hi - 4));
    if ((mask & need) === need) { straightHigh = hi; break; }
  }
  // wheel A-2-3-4-5 (ranks 12,0,1,2,3) -> high card is the 5 (rank 3)
  if (straightHigh === -1) {
    const wheel = (1 << 12) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);
    if ((mask & wheel) === wheel) straightHigh = 3;
  }

  // Sort ranks by (count desc, rank desc) for tiebreak ordering.
  const order = [...Array(13).keys()]
    .filter((r) => counts[r] > 0)
    .sort((x, y) => (counts[y] - counts[x]) || (y - x));

  const pack = (cat: number, tb: number[]) => {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 16 + (tb[i] || 0);
    return v;
  };

  const countsSorted = order.map((r) => counts[r]);

  if (isFlush && straightHigh >= 0) return pack(CAT.STRAIGHT_FLUSH, [straightHigh]);
  if (countsSorted[0] === 4) return pack(CAT.QUADS, [order[0], order[1]]);
  if (countsSorted[0] === 3 && countsSorted[1] === 2) return pack(CAT.FULL, [order[0], order[1]]);
  if (isFlush) return pack(CAT.FLUSH, ranks.slice().sort((a, b) => b - a));
  if (straightHigh >= 0) return pack(CAT.STRAIGHT, [straightHigh]);
  if (countsSorted[0] === 3) return pack(CAT.TRIPS, [order[0], order[1], order[2]]);
  if (countsSorted[0] === 2 && countsSorted[1] === 2) return pack(CAT.TWO_PAIR, [order[0], order[1], order[2]]);
  if (countsSorted[0] === 2) return pack(CAT.PAIR, [order[0], order[1], order[2], order[3]]);
  return pack(CAT.HIGH, order.slice(0, 5));
}

const COMBOS5_OF_7 = (() => {
  const res: number[][] = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) res.push([a, b, c, d, e]);
  return res; // 21 combinations
})();

// Evaluate exactly 7 card ids -> comparable strength.
export function evaluate7(cards: number[]): number {
  const ranks = cards.map(rankOf);
  const suits = cards.map(suitOf);
  let best = -1;
  for (const idx of COMBOS5_OF_7) {
    const v = score5(
      [ranks[idx[0]], ranks[idx[1]], ranks[idx[2]], ranks[idx[3]], ranks[idx[4]]],
      [suits[idx[0]], suits[idx[1]], suits[idx[2]], suits[idx[3]], suits[idx[4]]]
    );
    if (v > best) best = v;
  }
  return best;
}
