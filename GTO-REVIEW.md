# Tengan GTO Logic — Current State & Gaps vs TexasSolver

Updated after the solver rebuild: the river and turn are now **true
range-vs-range Discounted-CFR solves** (the same algorithm as
bupticybee/TexasSolver), the range-builder is position/pot/action aware, solves
run off the main thread, and the flop has a native-TexasSolver solve-server.

---

## 1. How the advisor works now, by street

| Street | Engine | Type | Latency |
|---|---|---|---|
| Preflop | hand-typed chart + Nash push/fold (≤25bb MTT) + **iso-raise over limpers** | lookup | instant |
| Flop | range-aware polar heuristic (in-engine) **+** native TexasSolver via local solve-server | heuristic / true (server) | instant / seconds (server) |
| Turn | two-street (turn+river) DCFR, range vs range | **true GTO** | ~7–9s, off-thread |
| River | single-street DCFR, range vs range | **true GTO** | ~0.4s, off-thread |
| Multiway (3+) | **equity-vs-field heuristic** (Monte-Carlo vs N opponents) | heuristic | ~0.1–0.3s, off-thread |

**Preflop — iso over limpers (real-game lever for 9-max micro).** A limped pot
(limpers in front, no raise) routes to `isoAdvice`: value hands isolate for value
with limp-aware sizing (3bb + 1bb/limper), small pairs and suited connectors
overlimp to set-mine / see a cheap multiway flop, the BB iso-raises value and
checks the rest, and trash folds. The iso range tightens as limpers grow. The
jam-vs-raise decision uses the **hero's own stack** (not the table minimum — a lone
short-stacked limper no longer makes a deep hero "jam").

**Range grid is now a true GTO solved-range view postflop (heads-up).** The 13×13
matrix shows the *solved range's* strategy: each class blends the per-combo
bet/check/call/raise/fold frequencies from the actual solve (in-engine CFR or
native TexasSolver), with out-of-range classes faded and the hero's hand
highlighted. Preflop keeps the chart grid and now picks the right facing —
RFI / vs-raise / **iso-vs-limpers**. Multiway postflop shows no solved grid
(labeled "preflop entry range — no postflop solve here"), because multiway isn't
GTO-solvable. So the grid is *true GTO where truth exists*, and honestly marked
where it doesn't.

**Auto-advise fires on the real actor (`m.ai`), not the hero-seat marker
(`m.ci`).** `m.ci` is the local-player seat (constant per hand), so the old gate
`m.ci === heroSeat` was always true and the HUD recomputed advice on nearly every
frame — flickering through mid-action reads before settling. Gating on `m.ai`
(the seat actually to act) cut auto-advice recomputes ~54% on the live logs (244 →
112), still covering every genuine decision (51/51 hands, zero dropped).

**Effective stack is hero-relative (postflop sizing fix).** Bet sizing, the
all-in cap, and SPR now use `min(heroStack, deepest-opponent stack)` instead of
the table minimum. Previously a lone short stack in the pot made every normal
50–66%-pot bet get mislabeled "all-in" and undersized to the shortest stack
(seen in the live logs: deep 138–426bb hero hands reading "ALL-IN"). A genuinely
short hero still correctly jams.

**Multiway — equity vs the field.** 3+ way pots compute Monte-Carlo equity where
hero must beat *every* opponent (not a heads-up range), then act off equity
relative to a fair share `1/(N+1)`: value-bet only when clearly ahead of the field
(overpairs/TPTK/sets, scaled by player count), pot-control medium hands, semi-bluff
draws at low frequency, and call/fold facing a bet on field-equity vs price. Pure
bluffing is suppressed (few of N opponents fold). This is the path for ~84% of
real 9-max flops — still an approximation (multiway is not GTO-solvable by any
solver), but a principled one.

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
- **Native postflop path** is wired through the solver toggle for heads-up flop,
  turn, and river, with in-engine fallback if the server is unreachable or times
  out.
- **Transparency:** every recommendation carries solver backend/status metadata
  plus range diagnostics for heads-up postflop assumptions.
- **Multiway is honestly flagged** rather than solved with a wrong HU model.

---

## 5. Remaining gaps / levers (per-opponent reads intentionally excluded)

1. **Native runtime dependency.** Full-depth flop/turn/river solves need the
   local solve-server. The HUD reports `checking`, `ready`, `solving`, `solved`,
   `timeout`, `unreachable`, or `error` and keeps the in-engine fallback.
2. **Turn precision / speed.** ~2% exploitable (more iterations would tighten);
   one bet size + all-in on the turn tree (river has two); river-card isomorphism
   would let the turn use full ranges (board-dependent payoff, flop groundwork).
3. **Multiway** stays a flagged heuristic — true multiway solving is out of scope
   (TexasSolver is heads-up too).
4. **Range realism.** Ranges assume textbook opening/continuing; against real
   recreational opponents the assumed ranges, not the last few % of GTO
   precision, are the main limiter. (Per-opponent exploit ranges are deliberately
   left out of scope.)

---

## 6. Honesty / caveats

- A solve is only as good as the **ranges** fed to it; the builder conditions on
  position, pot type, call/continue lines, and aggressor barrels, but not on
  per-opponent reads.
- The turn is **bounded** (cap 130 combos, ~70 iters) for live latency — lifting
  that toward full ranges needs river-card isomorphism or the native server.
- Native flop/turn/river solves are opt-in and depend on the local server; the
  fallback remains instant and explicitly labeled.
- Heads-up postflop can be solved; multiway falls back to the heuristic with a
  flag.
