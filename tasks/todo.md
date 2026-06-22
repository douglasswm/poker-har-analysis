# Native Solver and Postflop HUD Visibility Bug

## Plan

- [x] Confirm current worktree, task notes, and lessons.
- [x] Build a repro loop for `Native solver: unreachable`.
- [x] Diagnose server startup, solver binary configuration, URL, and HUD fallback paths.
- [x] Implement native-solver health preflight and postflop fallback visibility fixes.
- [x] Update `tasks/lessons.md` with the correction pattern.
- [x] Run focused native-solver health checks plus repo verification.
- [x] Document review results.

## Review

- Reproduced the original symptom: `npm run solver:check` fails with
  `native solver unreachable: server not running · http://127.0.0.1:7333`
  when nothing listens on port 7333.
- Confirmed the old server could falsely report `ok:true` while `/solve` failed
  with `spawnSync console_solver ENOENT`.
- Added solver-server readiness checks for executable and `resources/`, plus
  `npm run solver` and `npm run solver:check`.
- Updated the HUD native path so an unreachable native server does not suppress
  the normal in-engine postflop worker solve.
- Verified with focused tests: `node test/solver-server.test.js` and
  `node test/bridge-native-fallback.test.js`.
- Verified localhost states: unreachable, backend-misconfigured, and ready with a
  disposable fake backend.
- Full `npm test`, `npm run typecheck`, and `npm run build` pass.
