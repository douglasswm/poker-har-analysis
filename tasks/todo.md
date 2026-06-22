# Native Solver Start Script

## Plan

- [x] Confirm current worktree, package scripts, ignore rules, and lessons.
- [x] Add a one-command native solver start script with local config loading.
- [x] Add an example config and ignore the user's real local config.
- [x] Update docs to use the start script instead of raw env-var commands.
- [x] Update `tasks/lessons.md` for the correction pattern.
- [x] Verify missing-config, fake-backend ready, full tests, typecheck, and build.
- [x] Document review results.

## Review

- Added `.solver.env.example` and ignored `.solver.env` for machine-local
  TexasSolver paths.
- Added `scripts/start-solver.mjs` and `scripts/solver-env.mjs`; `npm run solver`
  and `npm start` now load local config, validate it, then start the server.
- Kept the raw server available as `npm run solver:server`.
- Updated `npm run solver:check` to follow `.solver.env` port settings.
- Verified missing config fails with a clear setup message.
- Verified fake-backend config with `npm run solver:start -- --check`.
- Verified actual `npm run solver` starts localhost `7333` with a disposable fake
  backend and `npm run solver:check` reports ready.
- Full `npm test`, `npm run typecheck`, and `npm run build` pass.
