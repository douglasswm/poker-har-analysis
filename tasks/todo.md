# Preflop Re-Raise Advice Refresh Bug

## Plan

- [x] Confirm current worktree and prior task notes.
- [x] Build a regression loop for preflop re-raise advice updating.
- [x] Diagnose whether the stale recommendation comes from parsing, spot building, or auto-advice debounce.
- [x] Implement the smallest fix.
- [x] Update `tasks/lessons.md` with the correction pattern.
- [x] Run focused regression, full tests, typecheck, and build.
- [x] Document review results.

## Review

- Focused regression `node scripts/test.mjs` passes, including new coverage for
  "vs one raise" and "vs re-raise" preflop recommendations.
- Full `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes and regenerated the extension engine bundles.
