import { SpotInfo } from "./spot.js";
import { Combo, rankOf, suitOf } from "./cards.js";
import { handCategory } from "./evaluator.js";
import {
  Pos,
  toChartPos,
  rangeAtShift,
  expandRange,
  GENERIC_CONTINUE,
  GENERIC_CALL,
  THREEBET,
  THREEBET_CALL,
  handCode
} from "./ranges.js";

export interface RangeDiagnostics {
  heroRole: "aggressor" | "caller" | "unknown";
  villainRole: "aggressor" | "caller" | "unknown";
  heroPosition: string;
  villainPosition: string;
  potType: "limped" | "srp" | "3bet" | "unknown";
  heroCombos: number;
  villainCombos: number;
  filters: string[];
}

// Strong draw = flush draw (4 to a suit) or open-ended straight draw.
export function hasStrongDraw(cards: number[]): boolean {
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
  return best >= 4;
}

// Filter a range to hands that would continue (call a bet) on the prior board.
function narrowContinue(combos: Combo[], priorBoard: number[]): Combo[] {
  if (priorBoard.length < 3) return combos;
  const out = combos.filter((c) => {
    const all = [c.a, c.b, ...priorBoard];
    return handCategory(all).cat >= 1 || hasStrongDraw(all);
  });
  return out.length >= 8 ? out : combos;
}

function pairRankOf(cards: number[]): number {
  const counts = new Array(13).fill(0);
  for (const c of cards) counts[rankOf(c)]++;
  let best = -1;
  for (let r = 0; r < 13; r++) if (counts[r] >= 2) best = r;
  return best;
}

// Narrow an aggressor's range after prior betting. A single barrel mostly drops
// no-showdown air; multi-barrels polarize harder by removing middle-pair giveups.
function narrowBarrel(combos: Combo[], priorBoard: number[], barrels: number): Combo[] {
  if (barrels < 1 || priorBoard.length < 3) return combos;
  const topBoard = Math.max(...priorBoard.map(rankOf));
  const value: Combo[] = [], draws: Combo[] = [], medium: Combo[] = [], air: Combo[] = [];
  for (const c of combos) {
    const all = [c.a, c.b, ...priorBoard];
    const cat = handCategory(all).cat;
    if (cat >= 2 || (cat === 1 && pairRankOf(all) >= topBoard)) value.push(c);
    else if (hasStrongDraw(all)) draws.push(c);
    else if (cat === 1) medium.push(c);
    else air.push(c);
  }
  const bluffRatio = barrels >= 2 ? 0.8 : 1.2;
  const bluffN = Math.min(air.length, Math.max(0, Math.round(value.length * bluffRatio)));
  const keptAir: Combo[] = [];
  if (bluffN > 0) {
    const step = air.length / bluffN;
    for (let x = 0; x < air.length && keptAir.length < bluffN; x += step) keptAir.push(air[Math.floor(x)]);
  }
  const out = value.concat(draws, barrels >= 2 ? [] : medium, keptAir);
  return out.length >= 8 ? out : combos;
}

// Range-builder v2: construct hero + villain ranges from preflop position/action.
export function riverRanges(spot: SpotInfo): { hero: string[]; vill: string[] } {
  const heroPos = toChartPos(spot.heroPosition || "BTN");
  const villPos = toChartPos(spot.villainPos || "BTN");
  const threeBet = spot.potType === "3bet";

  const aggrRange = (pos: Pos): string[] => threeBet ? THREEBET : rangeAtShift(pos, 0);
  const callRange = (): string[] => threeBet ? THREEBET_CALL : GENERIC_CALL;

  let hero: string[], vill: string[];
  if (spot.heroRole === "aggressor") { hero = aggrRange(heroPos); vill = callRange(); }
  else if (spot.heroRole === "caller") { hero = callRange(); vill = aggrRange(villPos); }
  else { hero = GENERIC_CONTINUE; vill = GENERIC_CONTINUE; }

  const code = handCode(spot.heroCards[0], spot.heroCards[1]);
  if (!hero.includes(code)) hero = [...hero, code];
  return { hero, vill };
}

export function buildPostflopRanges(spot: SpotInfo): { heroR: Combo[]; villR: Combo[]; diagnostics: RangeDiagnostics } {
  const { hero, vill } = riverRanges(spot);
  const prior = spot.board.slice(0, spot.board.length - 1);
  const filters: string[] = [];
  let heroR = expandRange(hero, spot.board);
  let villR = expandRange(vill, spot.board);

  if (spot.heroContinued) { heroR = narrowContinue(heroR, prior); filters.push("hero:continued"); }
  if (spot.villainContinued) { villR = narrowContinue(villR, prior); filters.push("villain:continued"); }

  if ((spot.heroBarrels || 0) >= 1) {
    heroR = narrowBarrel(heroR, prior, spot.heroBarrels!);
    filters.push((spot.heroBarrels || 0) >= 2 ? "hero:barrel-polarized" : "hero:barrel-filtered");
  }
  if ((spot.villainBarrels || 0) >= 1) {
    villR = narrowBarrel(villR, prior, spot.villainBarrels!);
    filters.push((spot.villainBarrels || 0) >= 2 ? "villain:barrel-polarized" : "villain:barrel-filtered");
  }

  const heroRole = spot.heroRole || "unknown";
  const villainRole = spot.heroRole === "aggressor" ? "caller" : spot.heroRole === "caller" ? "aggressor" : "unknown";
  return {
    heroR,
    villR,
    diagnostics: {
      heroRole,
      villainRole,
      heroPosition: spot.heroPosition || "unknown",
      villainPosition: spot.villainPos || "unknown",
      potType: spot.potType || "unknown",
      heroCombos: heroR.length,
      villainCombos: villR.length,
      filters: filters.length ? filters : ["none"]
    }
  };
}

export function rangeDiagnostics(spot: SpotInfo): RangeDiagnostics {
  return buildPostflopRanges(spot).diagnostics;
}

export function ensureCombo(combos: Combo[], cards: number[]): Combo[] {
  const [a, b] = cards;
  if (combos.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))) return combos;
  return combos.concat([{ a, b, w: 1 }]);
}

export function capRange(combos: Combo[], max: number, keep?: number[]): Combo[] {
  if (combos.length <= max) return combos;
  const out: Combo[] = [];
  const step = combos.length / max;
  for (let x = 0; x < combos.length; x += step) out.push(combos[Math.floor(x)]);
  if (keep && keep.length === 2) {
    const has = out.some((c) => (c.a === keep[0] && c.b === keep[1]) || (c.a === keep[1] && c.b === keep[0]));
    if (!has) {
      const hc = combos.find((c) => (c.a === keep[0] && c.b === keep[1]) || (c.a === keep[1] && c.b === keep[0]));
      if (hc) out[0] = hc;
    }
  }
  return out;
}

export function solveCombos(spot: SpotInfo): { oop: Combo[]; ip: Combo[] } {
  let { heroR, villR } = buildPostflopRanges(spot);
  heroR = ensureCombo(heroR, spot.heroCards);
  return spot.heroIsOOP ? { oop: heroR, ip: villR } : { oop: villR, ip: heroR };
}
