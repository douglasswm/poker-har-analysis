# GTO Gap Implementation

## Plan

- [x] Confirm current solver paths, native bridge, and parity harness.
- [x] Add public-interface tests for solver/range metadata and range behavior.
- [x] Refactor range construction into a shared engine module.
- [x] Add recommendation solver metadata and range diagnostics.
- [x] Harden native solver status and timeout fallback.
- [x] Update docs so flop/native-solver status is consistent.
- [x] Run `npm run typecheck`, `npm test`, and `npm run build`.
- [x] Review changes and commit the scoped implementation.

## Review

- Added shared postflop range construction in `engine/src/rangebuilder.ts`.
- Added solver backend/status metadata and heads-up range diagnostics to recommendations.
- Added native-solver request diagnostics, panel status, health check, and depth-based request timeouts.
- Updated docs to reflect the current hybrid native/in-engine solver behavior.
- Verification passed: `npm run typecheck`, `npm test`, and `npm run build`.
- Manual review: no blocking findings; native live-server behavior still requires a running local solve-server for end-to-end browser validation.
- Committed scoped implementation as `Address GTO solver gaps`.
