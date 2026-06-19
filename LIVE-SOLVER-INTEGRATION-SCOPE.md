# Live Range-vs-Range Integration — Scope

> Status: design only. Not built. Decide before implementing.

This document scopes wiring **TexasSolver** (bupticybee) in as a live postflop
engine the HUD queries while you play, replacing our equity heuristic with true
range-vs-range GTO solves for flop/turn/river.

---

## 1. Why — what it buys us

Our engine reasons from **your one hand vs a fixed generic villain range**. A
real solver reasons from **your whole range vs their whole range**, which is the
only way to get genuine GTO: correct bluff frequencies, polarization, blocker
effects, and balanced sizing.

The benchmark against TexasSolver showed our heuristic upgrades (preflop role,
board texture, SPR, tighter facing-bet range, river fix) closed the *biggest*
gaps and run instantly. A live solver would close the rest **by construction**
instead of by hand-tuned thresholds:

| Gap | Heuristic upgrade | Live solver |
|---|---|---|
| Preflop role (caller checks to raiser) | ✅ approximated | ✅ exact (ranges encode it) |
| Board texture c-bet scaling | ✅ approximated | ✅ exact |
| SPR / commitment | ✅ approximated | ✅ exact |
| Over-calling air facing a bet | ✅ fixed | ✅ exact |
| River single-combo degeneracy | ✅ fixed (polar) | ✅ exact (true range solve) |
| Exact mixed frequencies, blockers, sizing | ⚠️ approximate | ✅ exact |

Honest estimate: the heuristics already capture ~70–80% of the solver's EV. The
live solver is for the last 20–30% and for spots the heuristic can't shape well
(multi-sizing trees, blocker-heavy rivers, unusual textures).

**Hard limit:** TexasSolver is postflop only. Preflop stays on our charts /
push-fold regardless.

---

## 2. Architecture

Three components. The solver must run on **your Mac** (it can't run in the
browser, and our sandbox can't reach your machine's localhost).

```
  Stake tab (Chrome)                 Your Mac (localhost)
  ┌────────────────────┐            ┌─────────────────────────┐
  │ Tengan extension   │  HTTP/JSON │ tengan-solve-server      │
  │  • capture spot    │ ─────────► │  • build TexasSolver cfg │
  │  • build ranges    │            │  • spawn console_solver  │
  │  • render strategy │ ◄───────── │  • parse dumped JSON     │
  └────────────────────┘            └─────────────────────────┘
```

1. **Local solve-server** — a small Node/Python process the user launches once.
   - Wraps the prebuilt `console_solver` (Mac release; no compiling needed).
   - `POST /solve` with `{board, pot, effStack, oopRange, ipRange, betSizes,
     accuracy, maxIter}` → writes a config file → runs the binary → parses the
     dumped `output.json` → returns the hero combo's strategy.
   - Listens on `127.0.0.1:PORT`, CORS-allows the extension origin.

2. **Range builder (in the extension)** — the hard part; see §3.

3. **HUD client** — when it's your turn postflop, POST the spot, render the
   returned mix in the existing strategy bar / graph. Falls back to today's
   instant heuristic if the server is down or the solve is too slow.

The extension needs `host_permission` for `http://127.0.0.1:PORT/*`.

---

## 3. The range builder — where the real work (and risk) is

A solver is only as right as the ranges fed to it. We must reconstruct **both
players' ranges as of the current decision**, from the action we parsed:

1. **Preflop ranges from position + action.** Map each player's preflop line to
   a starting range using our existing position + chart data: e.g. "BTN open →
   BTN RFI range", "BB call → BB flat range", "CO 3-bet → 3-bet range". We
   already track positions (locked per hand) and the preflop aggressor.
2. **Narrow per street by the actions taken.** Each postflop action filters the
   range: a c-bet keeps the c-betting subset, a check keeps the checking subset,
   a call keeps calls, etc. This is itself a strategy assumption (we'd assume
   opponents bet/check textbook ranges).
3. **Remove blockers** — your cards and the board.
4. **Hand the two ranges + board + pot + stack + bet sizes to the solver.**

**This is the bottleneck, not the solver.** Recreational Stake opponents do not
play textbook ranges, so "GTO for assumed ranges" can be confidently wrong if
the assumptions are off. Per-villain range adjustment (from the stats we already
collect) is a later refinement and still noisy on small samples.

---

## 4. Latency & caching

- A flop solve to ~0.5–2% exploitability is ~2–15s on a normal machine
  (we measured ~2s for a trimmed flop, ~17s at finer accuracy on a slow ARM box);
  turn/river are faster. Multi-sizing trees are slower.
- Budget: when it's your turn you typically have several seconds. Plan for:
  - **Fast preset** (single bet size, accuracy ~1%, capped iterations) for a
    sub-2s answer, with a "refine" pass if you have time.
  - **Show the heuristic instantly**, then replace it with the solve when it
    lands ("solving… → solved").
  - **Cache** solved spots by a key (board + ranges + pot/stack bucket); identical
    or isomorphic spots reuse the result.
  - **Pre-warm** the likely next decision while you're waiting (optional).

---

## 5. Failure modes & honesty

- **Wrong ranges → wrong-but-confident output.** Mitigate by showing the assumed
  ranges, and keep a "ranges are assumptions" disclaimer.
- **Solve too slow / times out** → fall back to the heuristic; never block.
- **Server not running** → HUD silently uses the heuristic (status pill shows
  "solver off").
- **Multiway pots** → TexasSolver is heads-up; multiway either skips to heuristic
  or solves vs the single most relevant opponent (approximation).
- **ToS / fair-play**: a real-time solver assist is a heavier tool than an
  advisory HUD; worth a conscious decision about where/whether to use it.

---

## 6. Phased plan

1. **Solve-server MVP** — wrap `console_solver`, `POST /solve`, hardcoded ranges,
   return hero strategy JSON. Prove the loop end-to-end on one spot.
2. **Range builder v1** — preflop ranges from position/action + per-street
   narrowing with textbook assumptions; blockers removed.
3. **HUD client + fallback** — call the server when it's your turn postflop;
   render the mix; instant heuristic fallback + "solving/solved" status.
4. **Latency** — fast preset, caching, isomorphism, optional pre-warm.
5. **Refinements** — multi-sizing trees, per-villain range nudges from stats,
   turn/river node handling, multiway policy.

Effort: (1) small, (2) **large — the bulk of the work**, (3) medium, (4) medium,
(5) ongoing.

---

## 7. Decisions needed before building

- **Accuracy vs latency target** (e.g. ≤2s @ ~1% exploitability vs slower/sharper).
- **Range assumptions**: pure textbook GTO ranges, or blend in observed
  per-villain tendencies from the Players tab (and from what sample size)?
- **Bet-size tree**: single size (fast) vs multi-size (accurate, slower).
- **Multiway policy**: skip to heuristic vs solve vs most relevant opponent.
- **Server runtime**: Node or Python wrapper; packaged launcher vs manual start.

**Recommendation:** start with the solve-server MVP + range builder v1 at a fast
single-size preset, keep the heuristic as the always-on fallback, and only invest
in multi-sizing / per-villain ranges once the basic loop proves it helps in real
hands.
