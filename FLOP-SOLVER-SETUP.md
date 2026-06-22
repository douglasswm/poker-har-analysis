# Flop Solver — Native TexasSolver Setup (#4)

The flop is too deep to solve in pure browser JS, so full-depth flop GTO uses the
real **bupticybee/TexasSolver** binary running locally on your Mac, behind a tiny
HTTP solve-server the HUD calls. River and turn already solve in-engine; this adds
the flop (and can also serve turn/river at full depth if you prefer).

> Status: **wired end-to-end.** The solve-server is built and tested against the
> real TexasSolver binary, and the HUD client is implemented (the "solver" toggle
> in the advice panel). Enable the toggle and run the server below; flop spots
> then show a true native solve, falling back to the in-engine heuristic if the
> server is unreachable or times out. The panel reports native status
> (`checking`, `ready`, `solving`, `solved`, `timeout`, `unreachable`, `error`)
> and the diagnostics export includes the range assumptions used.

---

> **No native binary?** `wasm/` builds TexasSolver to WebAssembly — a drop-in
> backend (`TENGAN_SOLVER_BIN=…/console_solver.js`) that needs no compiled C++
> binary. The single-threaded wasm source is proven byte-identical to the native
> binary; see `wasm/README.md`. (You still run this local server; a fully
> in-browser build is future work.)

## 1. Install TexasSolver

Download the macOS release from
<https://github.com/bupticybee/TexasSolver/releases>, unzip it. You'll get a
folder containing `console_solver` and a `resources/` directory. (Or build the
`console` branch from source: CMake + a C++17 compiler + OpenMP.)

## 2. Run the solve-server

From this repo:

```bash
TENGAN_SOLVER_BIN=/path/to/TexasSolver/console_solver \
TENGAN_SOLVER_CWD=/path/to/TexasSolver \
npm run solver
# -> Tengan solve-server on http://127.0.0.1:7333
```

- `TENGAN_SOLVER_BIN` — path to the `console_solver` executable.
- `TENGAN_SOLVER_CWD` — the install dir that contains `resources/` (defaults to the binary's dir).
- `TENGAN_SOLVER_PORT` — default `7333`.

Health check: `npm run solver:check` → `native solver ready: ...`.
The health endpoint now validates both the executable and the `resources/`
directory, so a running server with a missing backend reports a configuration
error instead of pretending to be ready.

## 3. Request protocol

`POST /solve` with JSON:

```json
{
  "board": "Qs,Jh,2h",
  "pot": 6,
  "effStack": 100,
  "oopRange": "TT,99,88,77,66,...,AQo,AJo,KJo,QJo",
  "ipRange":  "AA,KK,QQ,JJ,TT,AKs,...,AKo,AQo,KQo",
  "tree": {
    "flop":  { "bet": [33, 75], "raise": [60], "allin": true },
    "turn":  { "bet": [66], "allin": true },
    "river": { "bet": [50, 100], "allin": true }
  },
  "accuracy": 0.5, "maxIter": 100, "threads": 4
}
```

`tree` defines the bet tree: per street, `bet`/`raise`/`donk` are lists of sizes
(**% of pot**) and `allin` adds a shove. `donk` (an OOP lead into the prior
aggressor) is OOP-only. Omit `tree` and the server falls back to a single
size/street (`flopBet`/`turnBet`/`riverBet`, defaults 50/60/75). The raise cap is
TexasSolver's default (4). The HUD picks the tree from the depth preset (below).

Response: `{ "ms": <solveTime>, "strategy": <TexasSolver dump> }`. The strategy is
the solved tree; the root is OOP's first action (`actions` + per-combo `strategy`).
Navigate `childrens["CHECK"]` / `childrens["BET …"]` to reach the node where the
hero acts, then read the hero's combo.

Tested in-repo against the real binary: a `normal`-tree solve on `Qs,Jh,2h`
returned a root of `CHECK / BET 33% / BET 75% / ALLIN`, with hands mixing across
the two sizes (e.g. AKo: check 26% / bet 33% 45% / bet 75% 29%) — confirming the
multi-size tree produces real mixed sizing.

## 4. HUD client (wired)

Implemented in `bridge.js` + the engine:

- `manifest.json` grants `host_permissions: ["http://127.0.0.1:7333/*"]`.
- The advice panel has a **"solver" toggle**. Turn it on to route heads-up
  postflop spots to the native solve-server.
- Flow: on a **heads-up postflop** spot, the HUD shows the
  in-engine heuristic instantly, then `POST /solve` and **upgrades** the panel to
  the native solve when it returns (badge: "True solve (native TexasSolver ·
  flop) · Ns"). If the server is unreachable or times out it keeps the fallback.
- `TenganEngine.solverRequest(gs, positions, opts)` builds the board + both
  ranges from the same position/pot-type/continue-filter range-builder the
  in-engine solver uses, so native and in-engine agree on ranges. The request
  also carries range diagnostics: roles, positions, pot type, combo counts, and
  filters such as `villain:continued` or `villain:barrel-polarized`.
- `extractNative()` reads the hero's combo strategy out of the returned tree
  (root for OOP first-to-act; `childrens.CHECK` for IP checked-to).

Verified end-to-end against the real binary: `solverRequest` → `POST /solve` →
`extractNative` returns e.g. `bet 50% 71% / check 17% / all-in 13%`. Only the
browser→localhost transport runs on your machine (not the build sandbox).

Scope: **all heads-up postflop spots** — flop, turn, and river, whether you're
first to act, checked to, or facing a bet. The client navigates the solved tree
to your decision node by **replaying this street's actual betting sequence** from
the parsed action log (`streetActions`): from the root it follows each logged
check/call/bet/raise to the matching child, so it reaches deep nodes too —
bet → raise → you-face-the-raise, and further re-raises up to the tree's cap —
not just the first decision. Bet/raise actions match by the player's total
committed amount this street (the tree labels are totals, e.g. "RAISE 8"). If the
replay can't cleanly resolve (sparse log), it falls back to the proven one-level
nav (root for OOP-first, `childrens.CHECK` for IP checked-to, matching bet child
when facing the first bet). Flop is solved from the preflop ranges; turn/river
feed the flop/turn-narrowed combo ranges so the deep solve is accurate. Verified
against the real binary: a set facing a 50% bet → raise 73% / call 20%; AKo
overcards → fold 47% / raise 31% / call 20%; and replay reaches 3-deep re-raise
nodes (bet → raise → CALL / RAISE / FOLD) that the one-level nav could not.

## 4b. Latency controls

When the "solver" toggle is on, a **Fast / Normal / Deep** selector appears. Each
preset trades speed for sharpness (iterations + accuracy + range combo cap + the
**bet tree** sent to the server):

| Preset | maxIter | accuracy | range cap | bet tree (sizes, % pot) |
|---|---|---|---|---|
| Fast | 40 | 1.0 | 250 | flop 50 / turn 66 / river 75 (+ allin) |
| Normal | 80 | 0.5 | 400 | flop 33·75 / turn 66 / river 50·100 (+ allin) |
| Deep | 200 | 0.25 | 700 | flop 33·75·125 + donk 33 / turn 50·100 + raise / river 33·75·125 (+ allin) |

The HUD aborts native requests by preset if they exceed the live budget:
Fast 8s, Normal 25s, Deep 60s. Timeout is a status, not a hard failure; the
instant fallback recommendation remains visible.

Richer trees give finer sizing (the solver mixes across sizes — e.g. bet 33% vs
75% with different hands) at the cost of a wider tree and more solve time. Thread
count defaults to 4 (`state.solveThreads`) and is sent to the server. Turn/river
ranges are capped to the preset's combo cap (hero's hand always kept); the flop is
solved from preflop class-list ranges. Measured (slow sandbox): a 2-size flop
solve ≈ 34s at maxIter 30 — far quicker on a real multi-core machine; Fast's
single-size tree is the quickest, Deep the sharpest.

## 4c. Parity QA harness

`npm run parity` gates the GTO output against regressions and (optionally) cross-
checks it against the native binary. Two modes:

- **Regression gate (offline, no binary).** Solves a battery of **river and turn**
  spots (RiverSolver + the two-street TurnSolver) and diffs the OOP root strategy
  against committed golden references (`engine/test/parity.golden.json`).
  Deterministic — passes at 0.00% drift; fails if any spot's **mean** per-combo
  Δ > 2% or any **single** combo Δ > 5% (so a one-combo break trips it, on either
  street). Runs as part of `npm test` and in CI. Run `npm run parity:gen` to
  refresh goldens after an intended solver change. The river battery mirrors the
  advisor's live bet tree (33/75/100% + 75% raise + allin) so the gate guards the
  real config.
- **Live cross-check (`--live`, needs the server).**
  `TENGAN_SOLVER_URL=http://127.0.0.1:7333 npm run parity -- --live` solves the
  same spots natively with a matching bet tree and reports, per spot: **Δcheck**
  (the bet-vs-check decision agreement), the per-combo Δ, and the aggregate
  action frequencies engine/native side by side.

Measured (live, 4 spots): the **decision** agrees within **Δcheck ≤ 1%** on every
spot, and two spots are near-identical action-by-action. The larger *per-combo* Δ
on static boards (dry/monotone) is **bet-sizing non-uniqueness** — pot vs all-in
are near-substitutable there, so the two solvers split that mix differently while
betting the same total and reaching ~0.2% exploitability. It is not an error; the
aggregate frequencies in the output make this explicit.

## 5. Notes & limits

- **Latency:** a postflop solve is seconds to tens of seconds depending on
  preset/threads/range width. Treat it as an on-demand "deep solve." Use Fast on
  slow machines or wide spots; Deep when you want maximum sharpness.
- **Heads-up only:** TexasSolver (and our range model) is HU; multiway flops stay
  on the heuristic.
- **Range quality caps accuracy:** as everywhere, the solve is only as good as the
  ranges we feed it.
- Turn/river can also be routed here for full depth if you'd rather not use the
  in-engine solver — same protocol, just a 4- or 5-card board.
