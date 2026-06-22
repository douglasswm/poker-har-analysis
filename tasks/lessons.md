# Lessons

- Preflop advice state must include parsed action history, not only raw `GameState`
  chip totals. Re-raises need an explicit raise count so the advisor can
  distinguish "vs raise" from "vs re-raise", and auto-advice keys should include
  action count/max-bet state so sparse betting frames retrigger recommendations.
- Native-solver health must validate the actual backend, not just the localhost
  server process. A port can be reachable while `console_solver` or `resources/`
  is missing, so health checks and HUD status need separate "server not running"
  and "backend misconfigured" states.
