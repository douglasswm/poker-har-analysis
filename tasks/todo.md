# Folded Players Counted As Multiway Bug

## Plan

- [x] Confirm current worktree and relevant task notes.
- [x] Build a regression where folded seats must not count as active postflop opponents.
- [x] Diagnose whether fold state is lost in parser, bridge, spot builder, or advisor.
- [x] Fix the smallest boundary that can distinguish folded from live seats.
- [x] Update `tasks/lessons.md` with the correction pattern.
- [x] Run focused regression, full tests, typecheck, build, and relevant native verifier.
- [x] Document review results.

## Review

- Root cause: `engine/src/spot.ts` used the raw seat-state `s` field as a fold
  marker while the parser and live frames mark folds with `la === 1`.
- Fix: added one fold predicate in `buildSpot` and reused it for active-player
  counts, current max-bet scans, opponent stack scans, and preflop limper scans.
- Regression: a nine-seat postflop frame with seven `la: 1` folded seats failed
  before the fix with `active=9` and `solver.detail="multiway approximate"`;
  after the fix it passes with `active=2` and heads-up postflop advice.
- Rebuilt `src/engine.bundle.js` and `src/engine.worker.js` so the extension HUD
  loads the corrected engine.
- Verification passed: focused engine test, full `npm test`, `npm run typecheck`,
  `npm run build`, and `npm run solver:verify-hud`.
- Native HUD verifier output included displayable actions and `HUD native range
  grid: 169 cells`.
- No solver process was left listening on `127.0.0.1:7333`.
