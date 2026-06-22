# Plan: True TexasSolver-Grade GTO — Current State & Remaining Work

Re-review after wiring the native solve-server into the HUD. The headline has
changed: **with the local solve-server running, the HUD already produces true
TexasSolver output for heads-up postflop** (flop/turn/river, including
facing-a-bet) — because it *is* TexasSolver. The remaining work is no longer
"build a solver"; it's reducing the install dependency, improving the ranges fed
to it, and hardening coverage.

---

## 1. Status now

| Street | In-engine (no install) | Native server (toggle on) |
|---|---|---|
| Preflop | chart + MTT push/fold | — (TexasSolver is postflop-only; chart is parity-OK) |
| Flop | heuristic | **true TexasSolver solve** |
| Turn | **true 2-street CFR** (bounded, ~7–9s) | **true TexasSolver solve** |
| River | **true CFR**, matches TexasSolver 0.0% | **true TexasSolver solve** |
| Multiway | heuristic, flagged | n/a (HU only) |

Other facts:
- DCFR core validated: river matches TexasSolver at **mean 0.0%/combo**.
- Native path covers OOP-first, IP-checked-to, and facing-a-bet, on all postflop
  streets; depth presets (Fast/Normal/Deep) + thread count + range cap bound
  latency; instant heuristic fallback when the server is off.
- Range-builder: position + pot-type + continue-filter; serialized to the server
  (class-lists for flop, narrowed combos for turn/river).

So **for HU postflop with the server running, this is TexasSolver.** The gaps
below are what stands between that and a no-compromise, no-install, fully-robust
solver.

---

## 2. Remaining gaps

- **G1 — Install dependency.** True flop GTO needs the local server. The
  **WASM build** that removes the native-binary dependency is now **prepared and
  de-risked** (`wasm/`): the single-threaded source is proven **byte-identical** to
  the threaded binary (max |Δ| = 0 over 2,416 freqs), the CMake patch + `omp.h`
  stub are verified, and `build-wasm.sh` / `verify-wasm.mjs` / a server drop-in
  (`.js` BIN → run via node) are in place. The only step not run here is the `emcc`
  compile itself — the build sandbox's proxy blocks the emscripten toolchain host
  (403) and has no root; it runs in minutes on a normal machine. A fully in-browser
  (no-server) build is the remaining larger step (MEMFS + the 52 MB card dict via
  cached fetch).
- **G2 — Range accuracy (now the #1 quality lever).** A perfect solver on wrong
  ranges is wrong. Ranges are heuristic: textbook position/pot ranges + a caller
  continue-filter. ✅ **Aggressor multi-barrel narrowing is now done** — a player
  who bet 2+ streets polarizes (value + draws + a balanced bluff slice; middle/
  bottom-pair give-ups dropped), mirroring the caller filter on the bettor side.
  Applied to both the in-engine solves and the native serialization (`builtRanges`
  → `solveCombos`); barrel counts threaded from the bridge action log; verified by
  test (a BTN double-barrel range went 831→274 combos, kept all value, dropped all
  middle/bottom pairs). Still open: wider/more realistic base ranges and
  node-locked ranges from the exact action sequence. This caps *both* paths.
- **G3 — Bet-tree richness.** ✅ **Done on the native path.** The server now takes
  a per-street `tree` (multiple bet sizes + raises + an OOP donk + allin); the HUD
  picks it from the depth preset (Fast = 1 size/street; Normal = 2 flop + 2 river
  sizes; Deep = 3 sizes + flop donk + turn raise). Verified vs the live binary:
  hands mix across sizes (AKo: bet 33% 45% / bet 75% 29% / check 26%). Raise cap is
  TexasSolver's default (4). The **in-engine** solves still use compact size sets;
  widening those is the remaining slice (latency-bound in pure JS).
- **G4 — Deep-node navigation.** ✅ **Done.** The native client now navigates to
  hero's decision by **replaying this street's actual betting sequence** from the
  parsed action log (`streetActions`), following each check/call/bet/raise to the
  matching child — so it reaches deep re-raise lines (bet→raise→hero, and further,
  up to the tree cap), not just the first decision. Bet/raise match on the player's
  total committed amount (the tree labels are totals). Falls back to the proven
  one-level nav if the log can't cleanly resolve. Verified against the live binary
  (3-deep re-raise nodes resolve correctly).
- **G5 — Verification breadth.** ✅ **Automated parity harness + CI.**
  `npm run parity` (and `npm test`) runs a deterministic **regression gate** over
  **6 spots — 4 river + 2 turn** (RiverSolver + two-street TurnSolver), diffing the
  OOP root strategy vs committed golden refs: passes at 0.00%, trips on a mean >2%
  or any single-combo >5% drift (verified on both streets). The river battery
  mirrors the advisor's live bet tree. Wired into **GitHub Actions CI**
  (`.github/workflows/ci.yml`: typecheck + test + parity + build). Plus an optional
  **live cross-check** vs the native binary (Δcheck ≤ 1% on all river spots).
  Remaining: flop spots in the live cross-check; more textures.
- **G6 — Multiway.** HU only (TexasSolver too); stays a flagged heuristic.
- **(Non-gap) Preflop** — chart is parity-acceptable vs a postflop-only solver.

---

## 3. Prioritized plan

1. **Range accuracy (highest leverage, helps both paths).**
   - ✅ Aggressor **multi-barrel narrowing** — done (polarize after 2+ barrels;
     mirrors the caller continue-filter on the bettor side).
   - Wider, more realistic base ranges; per-street range refinement.
   - Stretch: node-locked ranges from the exact action sequence.
   Effort: M. Risk: L. Directly raises native *and* in-engine output quality.

2. **Richer bet trees (native first).** ✅ Done.
   - Multiple bet sizes per street + raises + OOP donk + allin, sent as a `tree`
     in the solve request; tied to the depth preset (more sizes on Deep).
   - Verified vs the live binary (real mixed sizing). Raise cap = default 4.
   - Remaining: widen the in-engine (pure-JS) size sets — latency-bound.

3. **Deeper native-tree navigation + parity QA.** ✅ Done.
   - `nodeForHero` walks arbitrary within-street action sequences (re-raises,
     multi-bet lines) by replaying the parsed action log; safe fallback to the
     one-level nav.
   - Automated parity harness (`npm run parity`): golden-regression gate on the
     in-engine solver + optional live cross-check vs the native binary. Verified.
   - Remaining: broaden the battery (turn/flop, more textures); add to CI.

4. **No-install parity — WASM TexasSolver.**
   - Compile TexasSolver to WebAssembly with pthreads (SharedArrayBuffer + workers,
     COOP/COEP). Full flop GTO in-browser, no server, no binary.
   Effort: L+ (largest, riskiest). The endgame for "no compromise, no install."

5. **In-engine richness (parallel, optional).**
   - Fast lookup hand evaluator; worker-pool parallelism; suit isomorphism — lift
     the in-engine caps and shorten the turn so the no-server path is stronger
     even before WASM.
   Effort: M–L.

6. **Multiway** — keep the flagged heuristic; not truly solvable (out of scope).

---

## 4. Recommended sequence

1. ✅ **G2 range accuracy** (aggressor multi-barrel narrowing) — done.
2. ✅ **G3 richer bet trees** on the native path — done (multi-size + donk tree,
   tied to depth presets, verified vs the live binary).
3. ✅ **G4 deeper navigation + parity QA harness** — done (action-sequence replay +
   `npm run parity` gate, verified vs the live binary).
4. 🔶 **G1 WASM** — build kit ready and de-risked (`wasm/`); single-threaded source
   proven byte-identical to the native binary. Run `wasm/build-wasm.sh` on a machine
   with emscripten to produce `console_solver.js`, then it's a drop-in server
   backend (no native binary). Fully in-browser (no server) is the remaining step.
   (Optional parallel: broaden the parity battery to turn/flop + CI; widen the
   in-engine bet sizes.)

---

## 5. Honest ceiling

- **With the local server:** this is TexasSolver for HU postflop today. The real
  limiter is the **ranges** (G2), not the solver.
- **Without a server:** river/turn are true GTO in-engine; the **flop** can't be
  solved at usable speed in pure JS — that needs **WASM** (G1) or the native
  server. There is no pure-JS shortcut around the flop tree. The WASM path is now
  prepared (`wasm/`, single-threaded source proven byte-identical to native); it
  removes the native-binary install once compiled with emscripten, and a fully
  in-browser build would remove the server too.
- **Multiway** is out of reach for any HU solver (ours or TexasSolver).
- Across everything, output quality is bounded by **range realism**, and against
  real opponents by the fact that they don't play textbook ranges.
