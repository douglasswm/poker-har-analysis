// Card model matching the Stake "front" protocol: id 0..51,
// rank = floor(id/4) (0=2 .. 12=A), suit = id%4 (0=c,1=d,2=h,3=s).
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
export const SUITS = ["c", "d", "h", "s"];
export const SUIT_GLYPH = ["♣", "♦", "♥", "♠"];

export function rankOf(id: number): number { return Math.floor(id / 4); }
export function suitOf(id: number): number { return id % 4; }

export function cardStr(id: number): string {
  if (id < 0 || id > 51) return "??";
  return RANKS[rankOf(id)] + SUIT_GLYPH[suitOf(id)];
}

export function parseCardList(s: string): number[] {
  if (!s) return [];
  return String(s).split(";").map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 51);
}

export type Combo = { a: number; b: number; w: number };

// Two combos / a combo and a board conflict if they share a card.
export function disjoint(a1: number, b1: number, a2: number, b2: number): boolean {
  return a1 !== a2 && a1 !== b2 && b1 !== a2 && b1 !== b2;
}
export function comboHitsBoard(a: number, b: number, board: number[]): boolean {
  return board.includes(a) || board.includes(b);
}
