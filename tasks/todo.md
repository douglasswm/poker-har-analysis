# Native Solver HUD Presentation Verification

## Plan

- [x] Confirm current worktree and native solver local config.
- [x] Identify the exact HUD seam that interprets native TexasSolver JSON.
- [x] Build a real-response verification command that asserts HUD-displayable actions.
- [x] Fix or refactor if the seam cannot be verified directly.
- [x] Run focused real-solver verification and full repo checks.
- [x] Document review results.

## Review

- Moved native TexasSolver response interpretation into a shared engine API:
  `nativeRecommendation`, `extractNativeActions`, `nativeNodeForHero`, and
  `nativeGrid`.
- Updated the HUD bridge to use `window.TenganEngine.nativeRecommendation()` for
  the same parsed recommendation object that verification uses.
- Added `npm run solver:verify-hud`, which starts the real local solver if
  needed, performs a real tiny `/solve`, and asserts the returned tree becomes
  HUD-displayable actions plus a 169-cell solved range grid.
- Real verifier output included:
  `HUD native headline: BET $0.06 (3.0BB) (50%)`,
  `HUD native rows: bet $0.06 (3.0bb) 50% / all-in 50%`,
  `HUD native note: True solve (native TexasSolver · flop) · 7s`, and
  `HUD native range grid: 169 cells`.
- Full `npm test`, `npm run typecheck`, and `npm run build` pass.
