# Lessons

- Preflop advice state must include parsed action history, not only raw `GameState`
  chip totals. Re-raises need an explicit raise count so the advisor can
  distinguish "vs raise" from "vs re-raise", and auto-advice keys should include
  action count/max-bet state so sparse betting frames retrigger recommendations.
- Native-solver health must validate the actual backend, not just the localhost
  server process. A port can be reachable while `console_solver` or `resources/`
  is missing, so health checks and HUD status need separate "server not running"
  and "backend misconfigured" states.
- User-facing native-solver setup must be a remembered command plus local config,
  not a long inline env-var command. If a feature needs machine-local paths, add
  a gitignored config file, an example, and a start script that validates it.
- When giving setup commands for dotfiles, call out the exact filename and avoid
  notation that can be mistaken for part of the path. A trailing `~` creates a
  different filename, so `.solver.env` and `.solver.env~` are not interchangeable.
- Fake backends are acceptable only as isolated test fixtures, and the final
  user-facing native-solver setup must clearly bind to a real TexasSolver binary.
  Explain test doubles explicitly before using them so they are not mistaken for
  production wiring.
