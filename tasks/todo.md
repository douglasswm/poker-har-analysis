# Native Solver Real Backend Setup

## Plan

- [x] Confirm current worktree, package scripts, ignore rules, and lessons.
- [x] Correct the `.solver.env` filename confusion.
- [x] Download and wire the official TexasSolver macOS release as the real backend.
- [x] Verify the real backend with health and a minimal `/solve` request.
- [x] Add an installer script so real-backend setup is repeatable.
- [x] Update docs and lessons to distinguish real backend setup from test doubles.
- [x] Verify installer/start/check paths plus full repo checks.
- [x] Document review results.

## Review

- `.solver.env` now points at the real official TexasSolver macOS release under
  the ignored `.solver-bin/` directory.
- Added `npm run solver:install`, which downloads the official GitHub macOS
  release, extracts it, chmods `console_solver`, and writes `.solver.env`.
- Verified `npm run solver:install` succeeds outside the sandbox.
- Verified `npm run solver` starts the real TexasSolver-backed server and
  `npm run solver:check` reports ready.
- Verified a minimal real `/solve` request returns a TexasSolver strategy
  (`ms` around 7.7s in the probe).
- Full `npm test`, `npm run typecheck`, and `npm run build` pass.
