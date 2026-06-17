// Instant GTO math — the verified formulas from our research. All take the bet
// size as a fraction of the pot (s). These run in microseconds and are always
// shown, independent of the CFR solve.

export function potOddsEquity(s: number): number {
  // equity needed to call = s / (1 + 2s)
  return s / (1 + 2 * s);
}

export function mdf(s: number): number {
  // minimum defense frequency = 1 / (1 + s)
  return 1 / (1 + s);
}

export function alpha(s: number): number {
  // attacker's required fold% for a 0-equity bluff to break even = s / (1 + s)
  return s / (1 + s);
}

export function bluffFraction(s: number): number {
  // river: fraction of a betting range that should be bluffs = s / (1 + 2s)
  return s / (1 + 2 * s);
}

export function valueToBluff(s: number): { value: number; bluff: number } {
  const b = bluffFraction(s);
  return { value: 1 - b, bluff: b };
}

export function spr(effStack: number, pot: number): number {
  return pot > 0 ? effStack / pot : Infinity;
}

// Amount to call as a fraction of the *current* pot, given a bet into a pot.
export function callFracOfPot(toCall: number, potBeforeCall: number): number {
  return potBeforeCall > 0 ? toCall / potBeforeCall : 0;
}

export interface SpotMath {
  potOddsPct: number;     // equity needed to call (%)
  mdfPct: number;         // minimum defense frequency (%)
  alphaPct: number;       // attacker fold threshold (%)
  bluffPct: number;       // optimal bluff share of a betting range (%)
  spr: number;
}

// Summarize the math for a spot facing a bet of `betFrac` pots, eff stack/pot.
export function spotMath(betFrac: number, effStack: number, pot: number): SpotMath {
  return {
    potOddsPct: +(potOddsEquity(betFrac) * 100).toFixed(1),
    mdfPct: +(mdf(betFrac) * 100).toFixed(1),
    alphaPct: +(alpha(betFrac) * 100).toFixed(1),
    bluffPct: +(bluffFraction(betFrac) * 100).toFixed(1),
    spr: +spr(effStack, pot).toFixed(2)
  };
}
