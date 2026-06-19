# Tengan GTO Logic — Current State & Gaps vs TexasSolver

Updated after the solver rebuild: the river and turn are now **true
range-vs-range Discounted-CFR solves** (the same algorithm as
bupticybee/TexasSolver), the range-builder is position/pot/action aware, solves
run off the main thread, and the flop has a native-TexasSolver solve-server.

---

## 1. How the advisor works now, by street

| Street | Engine | Type | Latency |
|---|---|---|---|
| Preflop | hand-typed chart + Nash push/fold (≤25bb MTT) | lookup | instant |
| Flop | range-aware polar heuristic (in-engine) **+** native TexasSolver via local solve-server | heuristic / true (server) | instant / seconds (server) |
| Turn | two-street (turn+river) DCFR, range vs range | **true GTO** | ~7–9s, off-thread |
| River | single-street DCFR, range vs range | **true GTO** | ~0.4s, off-thread |
| Multiway (3+) | polar heuristic, flagged "approximate" | heuristic | instant |

- **River / turn** build the hero's *and* villain's full ranges, run DCFR to
  equilibrium, and read the strategy for the hero's actual hand. Not equity, not
  a single combo — a real solve.
- **Preflop** is still a chart (mixed by range depth) + ante-aware jam/fold.
- **Flop** uses the polar heuristic in-engine; full-depth flop GTO is available
  by running the local solve-server (see `FLOP-SOLVER-SETUP.md`).
- Solves run in a **Web Worker**, so the HUD never freezes; a synchronous
  fallback keeps it working if a worker can't spawn.

---

## 2. Validation against TexasSolver

- **River — exact.** Driven range-vs-range on a river spot, our CFR solved to
  0.05% exploitability in ~960ms and matched TexasSolver's high-accuracy
  (0.16%) solve at **mean 0.0% per-combo** (no combo off by ≥25%). Our DCFR core
  reproduces TexasSolver's equilibrium.
- **Turn — close, converges.** Internal exploitability converges to ~0.3% on
  small ranges and ~2% live (cap 130 combos); vs TexasSolver's turn it lands
  within ~10% per-combo, the gap concentrated in draw hands and attributable to
  iteration count. The chance-node normalization bug (negative exploitability)
  is fixed.
- **Flop — server tested.** The local solve-server returns a full per-combo
  TexasSolver flop strategy; the client correctly extracts a hero combo's mix.

---

## 3. The range-builder (what feeds the solver)

Ranges are constructed from the actual hand, not a single generic range:

- **Aggressor = their seat's opening range** — tight from UTG (~199 combos),
  wide from the button (~844). 3-bet pots use tight, polarized ranges (~87).
- **Caller = a wide continuing range** (~193 combos).
- **Continue-filter:** a player who *called a bet* on an earlier street has air
  dropped (kept: made hand or strong draw on the board they called) — a
  flop-call range is much stronger than a flop-defend range.
- Ranges are **capped** (river 220, turn 130 combos) to keep solves fast; hero's
  exact hand is always retained.

Demonstrated effect: the same K♦Q♣ facing a river bet **calls vs a tight UTG
opener** but **raises for value vs a wide BTN opener** — the solve adapts to who
the villain is, which the old single-generic-range engine couldn't do.

---

## 4. What's solid now

- **River = true GTO**, range-aware (position + pot type + continue-filter),
  matching TexasSolver; AA value-bets, hands mix, sizing polarizes.
- **Turn = true two-street GTO** off-thread, trustworthy exploitability metric.
- **Preflop chart + ante-aware MTT push/fold**, position-stable.
- **Off-thread solving** (no UI freeze) + synchronous fallback.
- **Transparency:** every recommendation shows a source badge — green
  "True CFR solve · exploitability X%", amber "Multiway — approximate" /
  "Heuristic" — so you always know which engine produced the advice.
- **Multiway is honestly flagged** rather than solved with a wrong HU model.

---

## 5. Remaining gaps / levers (per-opponent reads intentionally excluded)

1. **Flop HUD wiring (last mile).** The solve-server is built and tested; the
   browser→localhost `fetch` in `bridge.js` is documented but not yet wired
   (needs the user's running server to verify). Flop currently uses the heuristic.
2. **Aggressor postflop narrowing.** The continue-filter narrows the *caller*;
   the *aggressor's* range isn't yet narrowed for multi-barrels (a double-barrel
   range should drop give-up hands and polarize). Caller side done, aggressor side pending.
3. **Turn precision / speed.** ~2% exploitable (more iterations would tighten);
   one bet size + all-in on the turn tree (river has two); river-card isomorphism
   would let the turn use full ranges (board-dependent payoff, flop groundwork).
4. **Multiway** stays a flagged heuristic — true multiway solving is out of scope
   (TexasSolver is heads-up too).
5. **Range realism.** Ranges assume textbook opening/continuing; against real
   recreational opponents the assumed ranges, not the last few % of GTO
   precision, are the main limiter. (Per-opponent exploit ranges are deliberately
   left out of scope.)

---

## 6. Honesty / caveats

- A solve is only as good as the **ranges** fed to it; the builder conditions on
  position, pot type, and the call/continue line, but not on per-opponent reads.
- The turn is **bounded** (cap 130 combos, ~70 iters) for live latency — lifting
  that toward full ranges needs river-card isomorphism or the native server.
- The flop is **not yet a live solve in the HUD** — it's the heuristic until the
  solve-server client is wired (see `FLOP-SOLVER-SETUP.md`).
- River/turn are **heads-up**; multiway falls back to the heuristic with a flag.
