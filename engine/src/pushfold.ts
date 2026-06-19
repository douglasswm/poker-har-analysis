// Short-stack tournament push/fold (jam-or-fold) advice.
//
// At ≤25bb in a tournament, preflop poker is push/fold, not small raises. This
// module provides ante-on open-jam (folded to you) and call-a-jam ranges by
// position class and effective stack, expanded from a 169-hand all-in-equity
// ranking. These approximate the well-known Nash equilibrium push/fold ranges
// (chip-EV, no ICM) — not a live solve, but the right shape for these spots.
import type { PreflopOption } from "./ranges.js";

// 169 hands ordered best→worst by all-in equity vs a representative short-stack
// calling range (~17%). This "push value" order (vs equity-vs-random) correctly
// values pocket pairs and suited aces for jam/fold decisions.
const RANK: string[] = [
  "AA","KK","QQ","JJ","AKs","TT","AKo","99","AQs","AQo","88","AJs","AJo",
  "77","KQs","ATs","55","66","ATo","A9s","A7s","44","KQo","A8s","33","A4s",
  "A9o","A5s","KJs","A6s","A8o","A3s","A2s","K9s","A7o","QJs","22","KTs","KJo",
  "A6o","KTo","K8s","JTs","T9s","QTs","A5o","K7s","98s","Q8s","Q9s","87s","97s",
  "A4o","J9s","76s","A3o","K6s","A2o","K3s","K5s","QJo","T8s","65s","K9o","JTo",
  "86s","J8s","96s","QTo","K4s","K2s","97o","T7s","95s","T9o","Q9o","Q6s","J7s",
  "Q7s","84s","64s","54s","98o","J5s","J9o","75s","85s","Q8o","65o","K8o","74s",
  "76o","87o","K7o","K5o","Q3s","Q4s","J6s","J4s","J8o","T8o","T5s","Q5s","93s",
  "75o","K3o","K2o","52s","K4o","T6s","53s","T7o","63s","86o","83s","43s","K6o",
  "Q6o","82s","64o","85o","62s","73s","96o","94s","J3s","Q4o","J2s","54o","Q7o",
  "T3s","T6o","92s","Q5o","T4s","T2s","Q2s","95o","74o","J7o","84o","53o","42s",
  "73o","T4o","72s","J6o","T5o","94o","Q3o","J4o","32s","J5o","43o","93o","52o",
  "63o","72o","T3o","92o","83o","62o","Q2o","T2o","J3o","32o","82o","J2o","42o"
];

// Cumulative fraction of all combos (1326) covered down to each rank index, so
// "top P% of range" maps to a hand cutoff weighted by combos (pairs=6, suited=4,
// offsuit=12) rather than by raw hand count.
const COMBO_FRAC: number[] = (() => {
  const combos = (code: string): number =>
    code.length === 2 ? 6 : (code[2] === "s" ? 4 : 12);
  const total = 1326;
  const out: number[] = [];
  let acc = 0;
  for (const c of RANK) { acc += combos(c); out.push(acc / total); }
  return out;
})();

// Fraction of the whole range (by combos) at least as strong as `code`.
function rangeFracOf(code: string): number {
  const i = RANK.indexOf(code);
  return i < 0 ? 1 : COMBO_FRAC[i];
}

export type PosClass = "EP" | "MP" | "CO" | "BTN" | "SB" | "BB";

function posClass(chartPos: string): PosClass {
  switch (chartPos) {
    case "UTG": return "EP";
    case "MP": case "HJ": return "MP";
    case "CO": return "CO";
    case "BTN": return "BTN";
    case "SB": return "SB";
    case "BB": return "BB";
    default: return "MP";
  }
}

// Effective-stack anchors (bb) for the range tables below.
const BB_ANCHORS = [8, 10, 12, 15, 20, 25];

// Open-jam frequency (% of hands to shove when folded to you), ante-on.
const OPEN_JAM: Record<PosClass, number[]> = {
  EP:  [25, 21, 18, 14, 10, 8],
  MP:  [31, 26, 22, 17, 13, 10],
  CO:  [44, 37, 31, 24, 19, 15],
  BTN: [62, 54, 47, 38, 30, 25],
  SB:  [70, 62, 55, 46, 38, 31],
  BB:  [0, 0, 0, 0, 0, 0] // BB doesn't open-jam (acts last unopened)
};

// Call-a-jam frequency (% of hands to call an all-in), ante-on. Tighter than
// open-jamming; BB calls widest (closes the action, best price).
const CALL_JAM: Record<PosClass, number[]> = {
  EP:  [16, 12, 10, 8, 6, 5],
  MP:  [18, 14, 11, 9, 7, 6],
  CO:  [21, 16, 13, 10, 8, 7],
  BTN: [25, 20, 16, 13, 10, 8],
  SB:  [27, 22, 18, 14, 11, 9],
  BB:  [30, 25, 20, 16, 13, 11]
};

function interp(anchors: number[], bb: number): number {
  const x = Math.max(BB_ANCHORS[0], Math.min(BB_ANCHORS[BB_ANCHORS.length - 1], bb));
  for (let i = 1; i < BB_ANCHORS.length; i++) {
    if (x <= BB_ANCHORS[i]) {
      const x0 = BB_ANCHORS[i - 1], x1 = BB_ANCHORS[i];
      const y0 = anchors[i - 1], y1 = anchors[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return anchors[anchors.length - 1];
}

export interface PushFoldResult {
  options: PreflopOption[];
  rationale: string;
}

// facing: "open" = folded to you (open-jam); "jam" = facing an all-in (call/fold).
export function pushFold(
  code: string, chartPos: string, effBB: number, facing: "open" | "jam"
): PushFoldResult {
  const pc = posClass(chartPos);
  const bbR = Math.round(effBB);

  if (facing === "open" && pc === "BB") {
    return { options: [{ action: "check", freq: 1 }], rationale: "BB — checked to you." };
  }

  const pct = (facing === "open" ? interp(OPEN_JAM[pc], effBB) : interp(CALL_JAM[pc], effBB)) / 100;
  const cf = rangeFracOf(code);
  const band = 0.03; // small boundary mix, like a solver's edge frequencies
  const act: PreflopOption["action"] = facing === "open" ? "allin" : "call";
  const verb = facing === "open" ? "jam" : "call the jam";

  if (cf <= pct - band) {
    return { options: [{ action: act, freq: 1 }], rationale: `${bbR}bb — ${verb} ${code}.` };
  }
  if (cf <= pct + band) {
    const f = 0.5;
    const opts: PreflopOption[] = act === "allin"
      ? [{ action: "allin", freq: f }, { action: "fold", freq: 1 - f }]
      : [{ action: "call", freq: f }, { action: "fold", freq: 1 - f }];
    return { options: opts, rationale: `${bbR}bb — ${code} is a borderline ${verb} (mix).` };
  }
  return { options: [{ action: "fold", freq: 1 }], rationale: `${bbR}bb — fold ${code}.` };
}
