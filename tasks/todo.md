# Native Solver Live Run Observability

## Plan

- [x] Confirm the current running solver server has no request-level logs.
- [x] Add `/solve` access/result logging to the solver server.
- [x] Restart the local solver server with request logging enabled.
- [x] Watch logs during the live HUD run.
- [x] Document whether `/solve` was called and whether TexasSolver returned a
  result the HUD can turn into a recommendation.

## Review

- Added request-level logging to `solver-server/server.js`. `POST /solve` now
  logs a request id, start fields, status code, solve time, root action count,
  and strategy combo count to stdout and `logs/solver-server.log`.
- Restarted the native solver server on `127.0.0.1:7333`; health is ready.
- Observed the live HUD with native solver toggled on. The visible HUD state was
  `You: not in hand`, hand `Pre-Deal`, and advice text `Multiway (8-way) —
  equity vs 7 opponents (approximate, not a solve)`.
- Watched the logging server during the live run. No `POST /solve` request hit
  the server, and `logs/solver-server.log` was not created because no solve
  request arrived.
- Conclusion: native solver is connected, but that observed HUD state was not
  actually solving. Native dispatch requires an advice trigger plus a heads-up
  flop/turn/river spot.
- Verification passed: `node --check solver-server/server.js`,
  `node test/solver-server.test.js`, and `npm run solver:check`.
