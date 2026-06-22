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
  heroStack?: number;           // hero's own chips (drives the preflop jam-vs-raise call)
  maxOppStack?: number;         // deepest active opponent's chips (for postflop sizing)
  heroPosition: string;         // SB/BB/BTN/UTG... from positions
  heroIsOOP: boolean;           // first to act on this street (approx)
  activePlayers: number;
  isTournament: boolean;        // tournament table (gs.tri present)
  tournamentId?: number;        // gs.tri (for matching tournament context)
  ante: number;                 // per-player ante this level (gs.av), 0 if none
  heroRole?: "aggressor" | "caller"; // hero's preflop role (last raiser vs caller)
  villainPos?: string;          // primary opponent's position label (for ranges)
  potType?: "limped" | "srp" | "3bet"; // preflop pot type (drives range width)
  heroContinued?: boolean;      // hero called a bet on a prior postflop street
  villainContinued?: boolean;   // villain called a bet on a prior postflop street
  heroBarrels?: number;         // # of prior postflop streets hero bet/raised (aggressor)
  villainBarrels?: number;      // # of prior postflop streets villain bet/raised (aggressor)
  limpers?: number;             // preflop: # of limpers in front of hero (no raise)
  preflopRaised?: boolean;      // preflop: has anyone raised above the BB?
  preflopRaiseCount?: number;   // preflop: number of bet/raise actions parsed this hand
}

const STREET: Record<number, SpotInfo["street"]> = { 1: "preflop", 2: "flop", 3: "turn", 4: "river" };

function isFoldedSeat(s: any): boolean {
  return s?.la === 1 || s?.folded === true;
}

// positions param: map seatIndex -> position label (from parser).
// opts: optionally force a hero seat and/or supply hole cards (for studying any
// seat, since opponents' cards are hidden in the stream).
export function buildSpot(
  gs: any,
  positions: Record<number, string>,
  opts?: { heroSeat?: number; heroCards?: number[]; heroRole?: "aggressor" | "caller"; villainPos?: string; potType?: "limped" | "srp" | "3bet"; heroContinued?: boolean; villainContinued?: boolean; heroBarrels?: number; villainBarrels?: number; preflopRaiseCount?: number }
): SpotInfo {
  const empty: SpotInfo = {
    ok: false, street: "pre-deal", heroCards: [], board: [], pot: 0, bb: 0,
    toCall: 0, effStack: 0, heroPosition: "", heroIsOOP: true, activePlayers: 0,
    isTournament: false, ante: 0
  };
  if (!gs || gs.gi == null) return { ...empty, reason: "no gamestate" };

  // Tournament context: gs.tri = tournament id (absent in cash); gs.av = ante.
  const isTournament = gs.tri != null && gs.tri !== 0;
  const ante = typeof gs.av === "number" ? gs.av : 0;

  const seats: any[] = gs.s || [];
  const m = gs.m || {};
  const d = gs.d || {};
  const board = parseCardList(d.c || "");
  const bb = gs.bbv || 2;

  // Hero seat: explicit override, else the seat exposing its own cards. The
  // local player's cards arrive in `dc` (older builds) or `d` (newer builds);
  // opponents' `d` is masked "-1;-1" and parses to <2 valid cards.
  const seatCards = (s: any): number[] => (s ? parseCardList(s.dc || s.d || "") : []);
  let heroSeat = -1, heroCards: number[] = [];
  if (opts && opts.heroSeat != null && seats[opts.heroSeat] && seats[opts.heroSeat].dn) {
    heroSeat = opts.heroSeat;
    heroCards = (opts.heroCards && opts.heroCards.length === 2)
      ? opts.heroCards.slice()
      : seatCards(seats[heroSeat]);
  } else {
    for (let i = 0; i < seats.length; i++) {
      const ids = seatCards(seats[i]);
      if (ids.length === 2) { heroSeat = i; heroCards = ids; break; }
    }
    if (opts && opts.heroCards && opts.heroCards.length === 2) heroCards = opts.heroCards.slice();
  }

  // Active (not folded, seated) players + effective stack + max bet on street.
  let active = 0, minStack = Infinity, maxBet = 0, heroBet = 0, heroStack = 0, maxOppStack = 0;
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (!s || !s.dn) continue;
    const folded = isFoldedSeat(s);
    if (!folded) { active++; if (typeof s.c === "number") minStack = Math.min(minStack, s.c); }
    if (typeof s.b === "number" && !folded) maxBet = Math.max(maxBet, s.b);
    if (i === heroSeat && typeof s.b === "number") heroBet = s.b;
    if (i === heroSeat && typeof s.c === "number") heroStack = s.c;
    if (i !== heroSeat && !folded && typeof s.c === "number") maxOppStack = Math.max(maxOppStack, s.c);
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

  // Preflop limper detection: with no raise (max bet == bb), a "limper" is any
  // active non-hero seat that has matched the BB voluntarily — i.e. its bet == bb
  // and it isn't the big blind (whose bb is a forced post). Drives iso-raising.
  const preflopRaised = street === "preflop" && maxBet > bb;
  let limpers = 0;
  if (street === "preflop" && !preflopRaised) {
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      if (!s || !s.dn || isFoldedSeat(s)) continue;    // empty / folded
      if (i === heroSeat) continue;                     // not the hero
      if (positions[i] === "BB") continue;              // BB post is not a limp
      if (typeof s.b === "number" && s.b === bb) limpers++;
    }
  }

  // Heuristic for "out of position": the player whose turn comes first
  // postflop is the one closest after the button. We approximate with the
  // hero's position label: SB/BB act earlier postflop than CO/BTN.
  // Out of position = everyone except the two latest seats (CO, BTN), who act
  // last postflop. Works for any table size / label set.
  const pos = positions[heroSeat] || "";
  const heroIsOOP = pos !== "CO" && pos !== "BTN";

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
    heroStack,
    maxOppStack,
    heroPosition: pos,
    heroIsOOP,
    activePlayers: active,
    isTournament,
    tournamentId: isTournament ? gs.tri : undefined,
    ante,
    heroRole: opts?.heroRole,
    villainPos: opts?.villainPos,
    potType: opts?.potType,
    heroContinued: opts?.heroContinued,
    villainContinued: opts?.villainContinued,
    heroBarrels: opts?.heroBarrels,
    villainBarrels: opts?.villainBarrels,
    limpers,
    preflopRaised,
    preflopRaiseCount: opts?.preflopRaiseCount
  };
}
