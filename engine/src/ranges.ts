// Preflop chart + range helpers. The RFI ranges below are reasonable 6-max
// defaults (not solver-exact); they give instant preflop guidance and seed
// approximate ranges for the postflop solver.
import { Combo, rankOf, suitOf, RANKS } from "./cards.js";
import { pushFold } from "./pushfold.js";

// At/under this many big blinds in a tournament, preflop is jam-or-fold.
const MTT_PUSHFOLD_BB = 25;

// 169-hand code, e.g. "AKs", "TT", "72o".
export function handCode(c1: number, c2: number): string {
  let r1 = rankOf(c1), r2 = rankOf(c2);
  const suited = suitOf(c1) === suitOf(c2);
  if (r1 < r2) { const t = r1; r1 = r2; r2 = t; }
  const hi = RANKS[r1], lo = RANKS[r2];
  if (r1 === r2) return hi + lo;          // pair, e.g. "TT"
  return hi + lo + (suited ? "s" : "o");
}

// Position buckets the chart is keyed by.
export type Pos = "UTG" | "MP" | "HJ" | "CO" | "BTN" | "SB" | "BB";

// Map a detailed seat label (UTG+1, UTG+2, LJ, HJ, …) to a chart bucket so the
// preflop ranges apply regardless of table size.
export function toChartPos(label: string): Pos {
  switch (label) {
    case "SB": return "SB";
    case "BB": return "BB";
    case "BTN": return "BTN";
    case "CO": return "CO";
    case "HJ": return "HJ";
    case "LJ": case "MP": return "MP";
    case "UTG": case "UTG+1": case "UTG+2": case "UTG+3": return "UTG";
    default: return "MP"; // unknown → neutral middle
  }
}

// RFI (raise-first-in) opening ranges per position, built cumulatively
// (each later position opens everything the earlier one does, plus more).
// Standard, reasonably-loose modern ranges — e.g. UTG opens AJo, HJ opens
// KJo/QJo/QTo, late positions open wide.
const PAIRS = ["22","33","44","55","66","77","88","99","TT","JJ","QQ","KK","AA"];
const SUITED_ACES = ["A2s","A3s","A4s","A5s","A6s","A7s","A8s","A9s","ATs","AJs","AQs","AKs"];

const R_UTG = [
  ...PAIRS, ...SUITED_ACES,
  "AKo","AQo","AJo","KQo",
  "KQs","KJs","KTs","K9s","QJs","QTs","Q9s","JTs","J9s","T9s","98s","87s","76s","65s"
];
const R_MP = [...R_UTG, "ATo","KJo","QJo","KTo","K8s","Q8s","J8s","T8s","97s","86s","54s"];
const R_HJ = [...R_MP, "A9o","A8o","QTo","JTo","K7s","K6s","Q7s","J7s","T7s","96s","75s","64s","53s"];
const R_CO = [...R_HJ,
  "A7o","A6o","A5o","A4o","A3o","A2o","K9o","Q9o","J9o","T9o","98o",
  "K5s","K4s","K3s","K2s","Q6s","Q5s","Q4s","J6s","J5s","T6s","95s","85s","74s","63s","52s","43s","32s"];
const R_BTN = [...R_CO,
  "K8o","K7o","K6o","K5o","K4o","K3o","K2o","Q8o","Q7o","Q6o","Q5o",
  "J8o","J7o","J6o","T8o","T7o","97o","87o","86o","76o","75o","65o","64o","54o","53o","43o",
  "J4s","J3s","J2s","T5s","T4s","T3s","T2s","94s","93s","84s","83s","73s","72s","62s","42s"];
const R_SB = [...R_HJ,
  "A7o","A6o","A5o","A4o","A3o","A2o","K9o","Q9o","J9o","T9o","98o",
  "K5s","K4s","K3s","K2s","Q6s","Q5s","J6s","T6s","95s","85s","74s","63s","52s","43s"];

const RFI: Record<Pos, string[]> = {
  UTG: R_UTG, MP: R_MP, HJ: R_HJ, CO: R_CO, BTN: R_BTN, SB: R_SB,
  BB: [] // BB defends by calling/3-betting vs a raise, handled separately
};

// Ordered tightest→loosest so the open range can be shifted by N buckets
// (Safe = one tighter, Aggressive = one looser). SB sits between HJ and CO in
// width but is handled as its own bucket so we shift it independently.
const OPEN_ORDER: Pos[] = ["UTG", "MP", "HJ", "CO", "BTN"];

// The open range for a position at an absolute bucket shift. shift -1 = play the
// next tighter position's range; +1 = the next looser. BB never opens.
export function rangeAtShift(pos: Pos, shift: number): string[] {
  if (pos === "BB") return [];
  if (pos === "SB") {
    if (shift <= -1) return R_HJ;
    if (shift >= 1) return R_BTN;
    return R_SB;
  }
  const i = OPEN_ORDER.indexOf(pos);
  if (i < 0) return RFI[pos] || [];
  const j = Math.max(0, Math.min(OPEN_ORDER.length - 1, i + shift));
  return RFI[OPEN_ORDER[j]];
}

// The standard open range for a position.
export function openRange(pos: Pos): string[] {
  return rangeAtShift(pos, 0);
}

// A single option in a (possibly mixed) preflop strategy.
export interface PreflopOption {
  action: "raise" | "call" | "fold" | "check" | "allin";
  freq: number;       // 0..1, options sum to ~1
  sizeBB?: number;    // for "raise" only
}
export interface PreflopAdvice {
  options: PreflopOption[];  // sorted by freq desc
  rationale: string;
}

// Below this many big blinds, opening / continuing becomes a shove-or-fold
// (raise-first-in all-in) decision instead of a small raise.
const SHOVE_BB = 25;

function sortOpts(opts: PreflopOption[]): PreflopOption[] {
  return opts.filter((o) => o.freq > 0.001).sort((a, b) => b.freq - a.freq);
}

// Preflop open sizes (BB) and the 3-bet size — standard 6-max defaults.
const OPEN_BB = 2.5;
const OPEN_SB_BB = 3;
const THREEBET_BB = 9;

// facing: "open" (unopened / limped pot — RFI), "raise" (someone raised).
// Returns a *mixed* strategy: hands deep in range take the aggressive action
// 100%; hands near the edge mix it with fold (like a solver). Short stacks shove.
export function preflopAdvice(
  c1: number, c2: number, pos: Pos,
  facing: "open" | "raise",
  stackBB: number = 100,
  tournament: boolean = false
): PreflopAdvice {
  const code = handCode(c1, c2);

  // Tournament short stack: jam-or-fold. A raise we face at this depth is
  // treated as a shove to call or fold against.
  if (tournament && stackBB <= MTT_PUSHFOLD_BB) {
    return pushFold(code, pos, stackBB, facing === "raise" ? "jam" : "open");
  }
  // Nested range buckets: core = always play, std = standard, ext = sometimes.
  const core = rangeAtShift(pos, -1);
  const std = rangeAtShift(pos, 0);
  const ext = rangeAtShift(pos, 1);

  // Graded "play this hand" frequency from how deep in range it sits.
  const playFreq = (): number => {
    if (core.includes(code)) return 1.0;
    if (std.includes(code)) return 0.66;
    if (ext.includes(code)) return 0.33;
    return 0;
  };

  const premium = ["AA","KK","QQ","AKs","AKo"].includes(code);
  const shortStack = stackBB <= SHOVE_BB;
  const bbRound = Math.round(stackBB);

  if (facing === "open") {
    if (pos === "BB") return { options: [{ action: "check", freq: 1 }], rationale: "BB — checked to you." };
    const f = playFreq();
    if (f <= 0) return { options: [{ action: "fold", freq: 1 }], rationale: `${code} is below the ${pos} opening range.` };
    if (shortStack) {
      const opts: PreflopOption[] = [{ action: "allin", freq: f }];
      if (f < 1) opts.push({ action: "fold", freq: 1 - f });
      return { options: sortOpts(opts), rationale: `${bbRound}bb — open-shove range from ${pos}.` };
    }
    const sizeBB = pos === "SB" ? OPEN_SB_BB : OPEN_BB;
    const opts: PreflopOption[] = [{ action: "raise", freq: f, sizeBB }];
    if (f < 1) opts.push({ action: "fold", freq: 1 - f });
    return { options: sortOpts(opts), rationale: f >= 1 ? `${code} opens from ${pos}.` : `${code} — borderline open from ${pos} (mix).` };
  }

  // ---- facing a raise ----
  const latePos = pos === "BTN" || pos === "BB" || pos === "CO" || pos === "HJ";
  if (shortStack) {
    // Shove-or-fold: premiums and core-range hands jam, edge hands mix jam/fold.
    if (premium) return { options: [{ action: "allin", freq: 1 }], rationale: `${bbRound}bb — shove ${code} over the raise.` };
    if (core.includes(code)) return { options: [{ action: "allin", freq: 1 }], rationale: `${bbRound}bb — re-shove ${code}.` };
    if (std.includes(code)) return { options: sortOpts([{ action: "allin", freq: 0.5 }, { action: "fold", freq: 0.5 }]), rationale: `${bbRound}bb — ${code} is a marginal re-shove (mix).` };
    return { options: [{ action: "fold", freq: 1 }], rationale: `Fold ${code} at ${bbRound}bb vs a raise.` };
  }

  // Deeper: 3-bet premiums for value; defend strong hands in position.
  if (premium) return { options: [{ action: "raise", freq: 1, sizeBB: THREEBET_BB }], rationale: `${code} — 3-bet for value.` };
  if (!latePos) return { options: [{ action: "fold", freq: 1 }], rationale: `${code} folds to the raise out of position.` };

  if (core.includes(code)) {
    return { options: [{ action: "call", freq: 1 }], rationale: `${code} — defend in ${pos}.` };
  }
  if (std.includes(code)) {
    // Marginal: call/fold mix.
    return { options: sortOpts([{ action: "call", freq: 0.5 }, { action: "fold", freq: 0.5 }]), rationale: `${code} — marginal defend in ${pos} (mix).` };
  }
  return { options: [{ action: "fold", freq: 1 }], rationale: `${code} folds to the raise.` };
}

// Hands strong enough to isolate limpers for value from any position — raised
// regardless of how many limpers (big pairs + strong broadways).
const ISO_CORE = ["AA","KK","QQ","JJ","TT","99","AKs","AKo","AQs","AQo","AJs","ATs","KQs","KQo","KJs"];

// Speculative hands prefer a cheap multiway flop (overlimp) to iso-raising:
//   - small/medium pairs 22-88 (set-mine), and
//   - suited connectors/gappers whose high card is T or lower (e.g. T9s..54s).
// Broadways (high card J+) and pairs 99+ are value hands and iso-raise instead.
function isSpeculative(code: string): boolean {
  if (code.length === 2) return RANKS.indexOf(code[0]) <= RANKS.indexOf("8"); // pair 22-88
  if (!code.endsWith("s")) return false;                                       // offsuit -> not a "see cheap flop" hand
  return RANKS.indexOf(code[0]) <= RANKS.indexOf("T");                         // suited, high card <= T
}

// Facing limpers (a limped pot, no raise): isolate strong hands for value with a
// limp-aware size (3bb + 1bb per limper), tighten the iso range as limpers grow,
// overlimp speculative/set-mine hands to see a cheap multiway flop, fold the rest.
// The BB sees a free flop, so it iso-raises value and checks everything else.
export function isoAdvice(
  c1: number, c2: number, pos: Pos, limpers: number,
  stackBB: number = 100, tournament: boolean = false
): PreflopAdvice {
  const code = handCode(c1, c2);
  const n = Math.max(1, limpers);
  const isBB = pos === "BB";

  // Tournament short stack: jam-or-fold the value range over the limps.
  if (tournament && stackBB <= MTT_PUSHFOLD_BB) {
    return pushFold(code, pos, stackBB, "open");
  }
  // Jam over limpers only when genuinely short; at 13-25bb you still iso-raise
  // small (a 25bb shove over a single limper is a leak), unlike an unopened RFI.
  const shortStack = stackBB <= 12;
  const sizeBB = 3 + n; // iso sizing: 3bb base + 1bb per limper
  const spec = isSpeculative(code);

  // Value range to iso-raise: the position's open range tightened by the limper
  // count (more limpers -> need a stronger hand) plus the always-iso core, minus
  // the speculative hands (which prefer to overlimp). "Playable" = worth a call.
  const inRange = ISO_CORE.includes(code) || rangeAtShift(pos, -n).includes(code);
  const playable = ISO_CORE.includes(code) || openRange(pos).includes(code);
  const isoRaise = inRange && !spec;
  const overlimp = spec && playable;

  if (isBB) {
    if (isoRaise) {
      if (shortStack) return { options: [{ action: "allin", freq: 1 }], rationale: `${Math.round(stackBB)}bb — jam ${code} over ${n} limper(s).` };
      return { options: [{ action: "raise", freq: 1, sizeBB }], rationale: `Iso-raise ${code} from BB to ${sizeBB}bb over ${n} limper(s).` };
    }
    return { options: [{ action: "check", freq: 1 }], rationale: `BB — check ${code} behind ${n} limper(s) (free flop).` };
  }

  if (shortStack) {
    if (isoRaise) return { options: [{ action: "allin", freq: 1 }], rationale: `${Math.round(stackBB)}bb — jam ${code} over ${n} limper(s).` };
    if (overlimp) return { options: [{ action: "call", freq: 1 }], rationale: `Set-mine / overlimp ${code} behind ${n} limper(s).` };
    return { options: [{ action: "fold", freq: 1 }], rationale: `Fold ${code} at ${Math.round(stackBB)}bb over limpers.` };
  }

  if (isoRaise) {
    return { options: [{ action: "raise", freq: 1, sizeBB }], rationale: `Iso-raise ${code} from ${pos} to ${sizeBB}bb over ${n} limper(s).` };
  }
  if (overlimp) {
    return { options: [{ action: "call", freq: 1 }], rationale: `Overlimp ${code} behind ${n} limper(s) — cheap multiway flop / set-mine.` };
  }
  return { options: [{ action: "fold", freq: 1 }], rationale: `Fold ${code} over ${n} limper(s) — too weak to iso, too weak to call multiway.` };
}

// ---- Preflop range matrix (13x13 grid) ----
// Ranks high→low for the grid axes (A in the top-left, 2 in the bottom-right).
const GRID_RANKS = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

export interface GridCell {
  code: string;          // e.g. "AKs"
  pair: boolean;
  suited: boolean;
  options: PreflopOption[];
}
export interface PreflopGrid {
  pos: Pos;
  facing: "open" | "raise" | "limp";
  cells: GridCell[];      // 169 cells, row-major (row 0 = A-high)
  legend: { allin: number; raise: number; call: number; check: number; fold: number }; // % over 1326 combos
}

// Compute the full strategy for all 169 hands at a position/facing/stack.
// facing "limp" = a limped pot (iso-raise over `limpers` limpers).
export function preflopGrid(
  posLabel: string,
  facing: "open" | "raise" | "limp",
  stackBB: number,
  tournament: boolean = false,
  limpers: number = 1
): PreflopGrid {
  const pos = toChartPos(posLabel || "BTN");
  const cells: GridCell[] = [];
  const tally: Record<string, number> = { allin: 0, raise: 0, call: 0, check: 0, fold: 0 };
  let totalCombos = 0;

  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const hiRank = GRID_RANKS[Math.min(r, c)];   // higher rank (lower index)
      const loRank = GRID_RANKS[Math.max(r, c)];
      const pair = r === c;
      const suited = c > r;                          // upper triangle = suited
      let c1: number, c2: number, combos: number;
      if (pair) { c1 = hiRank * 4 + 0; c2 = hiRank * 4 + 1; combos = 6; }
      else if (suited) { c1 = hiRank * 4 + 0; c2 = loRank * 4 + 0; combos = 4; }
      else { c1 = hiRank * 4 + 0; c2 = loRank * 4 + 1; combos = 12; }

      const adv = facing === "limp"
        ? isoAdvice(c1, c2, pos, limpers, stackBB, tournament)
        : preflopAdvice(c1, c2, pos, facing, stackBB, tournament);
      cells.push({ code: handCode(c1, c2), pair, suited, options: adv.options });
      for (const o of adv.options) tally[o.action] = (tally[o.action] || 0) + o.freq * combos;
      totalCombos += combos;
    }
  }

  const legend = {
    allin: +(tally.allin / totalCombos * 100).toFixed(2),
    raise: +(tally.raise / totalCombos * 100).toFixed(2),
    call: +(tally.call / totalCombos * 100).toFixed(2),
    check: +(tally.check / totalCombos * 100).toFixed(2),
    fold: +(tally.fold / totalCombos * 100).toFixed(2)
  };
  return { pos, facing, cells, legend };
}

// ---- Postflop range grid (from a solved per-combo strategy) ----
// A 13x13 view of the hero's *solved* range on the current board: each class
// cell blends the GTO action frequencies of that class's combos that are in the
// range (suit combos that differ on the board are averaged). Cells with no combo
// in the solved range are marked out-of-range. Only meaningful heads-up, where a
// true range-vs-range solve exists.
export interface RangeGridCell {
  code: string;
  pair: boolean;
  suited: boolean;
  inRange: boolean;
  options: { action: string; freq: number }[]; // blended, action kinds (bet/raise/call/check/fold/allin)
}
export interface RangeGrid {
  cells: RangeGridCell[];                         // 169, row-major (row 0 = A-high)
  legend: Record<string, number>;                // % of in-range combos per action kind
}

// actionKinds: normalized kind per action index (e.g. ["check","bet","bet","allin"]).
// combos: each combo's id pair + freqs aligned to actionKinds. Same-kind actions
// (e.g. two bet sizes) are merged per cell.
export function rangeGrid(actionKinds: string[], combos: { a: number; b: number; freqs: number[] }[]): RangeGrid {
  const byCode: Record<string, { sum: number[]; n: number }> = {};
  for (const c of combos) {
    const code = handCode(c.a, c.b);
    const e = byCode[code] || (byCode[code] = { sum: actionKinds.map(() => 0), n: 0 });
    for (let i = 0; i < actionKinds.length; i++) e.sum[i] += (c.freqs[i] || 0);
    e.n++;
  }
  const cells: RangeGridCell[] = [];
  const legendSum: Record<string, number> = {};
  let inRangeCombos = 0;
  for (let r = 0; r < 13; r++) {
    for (let cc = 0; cc < 13; cc++) {
      const hiRank = GRID_RANKS[Math.min(r, cc)], loRank = GRID_RANKS[Math.max(r, cc)];
      const pair = r === cc, suited = cc > r;
      let a: number, b: number;
      if (pair) { a = hiRank * 4; b = hiRank * 4 + 1; }
      else if (suited) { a = hiRank * 4; b = loRank * 4; }
      else { a = hiRank * 4; b = loRank * 4 + 1; }
      const code = handCode(a, b);
      const e = byCode[code];
      if (e && e.n > 0) {
        const merged: Record<string, number> = {};
        for (let i = 0; i < actionKinds.length; i++) merged[actionKinds[i]] = (merged[actionKinds[i]] || 0) + e.sum[i] / e.n;
        const options = Object.keys(merged).map((k) => ({ action: k, freq: +merged[k].toFixed(4) }))
          .filter((o) => o.freq > 0.004).sort((x, y) => y.freq - x.freq);
        cells.push({ code, pair, suited, inRange: true, options });
        for (const o of options) legendSum[o.action] = (legendSum[o.action] || 0) + o.freq * e.n;
        inRangeCombos += e.n;
      } else {
        cells.push({ code, pair, suited, inRange: false, options: [] });
      }
    }
  }
  const legend: Record<string, number> = {};
  for (const k of Object.keys(legendSum)) legend[k] = +(legendSum[k] / Math.max(1, inRangeCombos) * 100).toFixed(1);
  return { cells, legend };
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

// A realistic "reached this street / would call" range (~top 25%), sized to
// keep the live CFR solve fast (≈200 combos). Used as the caller's range in the
// range-vs-range river solve. Offsuit combos kept minimal (they cost 12 each).
export const GENERIC_CALL: string[] = [
  "AA","KK","QQ","JJ","TT","99","88","77","66","55","44","33","22",
  "A2s","A3s","A4s","A5s","A6s","A7s","A8s","A9s","ATs","AJs","AQs","AKs",
  "KTs","KJs","KQs","QTs","QJs","JTs","T9s","98s","87s","76s","65s","54s",
  "AQo","AKo","KQo","AJo"
];

// Preflop 3-bettor's range (tight value + a few suited bluffs) and the range
// that calls a 3-bet. Used to seed solver ranges in 3-bet pots, which are much
// tighter and more polarized than single-raised pots.
export const THREEBET: string[] = [
  "AA","KK","QQ","JJ","TT","AKs","AQs","AJs","ATs","A5s","A4s","KQs","KJs","QJs","JTs","AKo","AQo","KQo"
];
export const THREEBET_CALL: string[] = [
  "AA","KK","QQ","JJ","TT","99","88","AKs","AQs","AJs","ATs","KQs","KJs","QJs","JTs","T9s","AKo","AQo"
];

// A tighter, value-weighted range for when villain has *bet/raised* (they show
// up stronger than their whole continuing range). Used when hero faces a bet so
// equity isn't overstated — stops the engine from over-calling air.
export const GENERIC_CBET: string[] = [
  "AA","KK","QQ","JJ","TT","99","88","77","66","55","44","33","22",
  "AKs","AQs","AJs","ATs","A9s","A5s","A4s","KQs","KJs","KTs","QJs","QTs","JTs","T9s","98s","87s","76s","65s",
  "AKo","AQo","AJo","KQo","KJo","QJo"
];
