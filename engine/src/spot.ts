// Build a decision "spot" from a raw front-protocol GameState (json.gameState).
// Extracts everything the advisor needs: hero cards, board, pot, to-call,
// effective stack, position, street.
import { parseCardList } from "./cards.js";

export interface SpotInfo {
  ok: boolean;
  reason?: string;
  tableId?: number;
  handId?: number;
  street: "preflop" | "flop" | "turn" | "river" | "pre-deal";
  heroSeat?: number;
  heroCards: number[];          // hero hole-card ids (empty if not seated)
  board: number[];              // community card ids
  pot: number;                  // current pot (chips)
  bb: number;                   // big blind value (chip units)
  toCall: number;               // chips hero must call (0 if no bet pending)
  effStack: number;             // smallest active stack behind (approx)
  heroPosition: string;         // SB/BB/BTN/UTG... from positions
  heroIsOOP: boolean;           // first to act on this street (approx)
  activePlayers: number;
}

const STREET: Record<number, SpotInfo["street"]> = { 1: "preflop", 2: "flop", 3: "turn", 4: "river" };

// positions param: map seatIndex -> position label (from parser).
// opts: optionally force a hero seat and/or supply hole cards (for studying any
// seat, since opponents' cards are hidden in the stream).
export function buildSpot(
  gs: any,
  positions: Record<number, string>,
  opts?: { heroSeat?: number; heroCards?: number[] }
): SpotInfo {
  const empty: SpotInfo = {
    ok: false, street: "pre-deal", heroCards: [], board: [], pot: 0, bb: 0,
    toCall: 0, effStack: 0, heroPosition: "", heroIsOOP: true, activePlayers: 0
  };
  if (!gs || gs.gi == null) return { ...empty, reason: "no gamestate" };

  const seats: any[] = gs.s || [];
  const m = gs.m || {};
  const d = gs.d || {};
  const board = parseCardList(d.c || "");
  const bb = gs.bbv || 2;

  // Hero seat: explicit override, else the seat exposing its own cards (dc).
  let heroSeat = -1, heroCards: number[] = [];
  if (opts && opts.heroSeat != null && seats[opts.heroSeat] && seats[opts.heroSeat].dn) {
    heroSeat = opts.heroSeat;
    const s = seats[heroSeat];
    heroCards = (opts.heroCards && opts.heroCards.length === 2)
      ? opts.heroCards.slice()
      : (s.dc ? parseCardList(s.dc) : []);
  } else {
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      if (s && s.dc) { heroSeat = i; heroCards = parseCardList(s.dc); break; }
    }
    if (opts && opts.heroCards && opts.heroCards.length === 2) heroCards = opts.heroCards.slice();
  }

  // Active (not folded, seated) players + effective stack + max bet on street.
  let active = 0, minStack = Infinity, maxBet = 0, heroBet = 0;
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (!s || !s.dn) continue;
    const folded = s.s === 4;
    if (!folded) { active++; if (typeof s.c === "number") minStack = Math.min(minStack, s.c); }
    if (typeof s.b === "number" && !folded) maxBet = Math.max(maxBet, s.b);
    if (i === heroSeat && typeof s.b === "number") heroBet = s.b;
  }
  if (!isFinite(minStack)) minStack = 0;

  // Prefer the betting-round code; otherwise infer from how many board cards
  // are out (5=river, 4=turn, 3=flop, else preflop/pre-deal).
  const byBoard: Record<number, SpotInfo["street"]> =
    { 5: "river", 4: "turn", 3: "flop" };
  const street = STREET[m.r] || byBoard[board.length] ||
    (gs.sfgs < 0 ? "pre-deal" : "preflop");
  const pot = typeof d.p === "number" ? d.p : 0;
  const toCall = Math.max(0, maxBet - heroBet);

  // Heuristic for "out of position": the player whose turn comes first
  // postflop is the one closest after the button. We approximate with the
  // hero's position label: SB/BB act earlier postflop than CO/BTN.
  const pos = positions[heroSeat] || "";
  const earlyPost = ["SB", "BB", "UTG", "UTG+1", "MP", "HJ"]; // earlier to act postflop
  const heroIsOOP = earlyPost.includes(pos);

  return {
    ok: heroSeat >= 0,
    reason: heroSeat < 0 ? "hero not seated (spectating)" : undefined,
    tableId: gs.ti,
    handId: gs.gi,
    street,
    heroSeat,
    heroCards,
    board,
    pot,
    bb,
    toCall,
    effStack: minStack,
    heroPosition: pos,
    heroIsOOP,
    activePlayers: active
  };
}
