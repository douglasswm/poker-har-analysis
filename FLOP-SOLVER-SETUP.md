# Flop Solver — Native TexasSolver Setup (#4)

The flop is too deep to solve in pure browser JS, so full-depth flop GTO uses the
real **bupticybee/TexasSolver** binary running locally on your Mac, behind a tiny
HTTP solve-server the HUD calls. River and turn already solve in-engine; this adds
the flop (and can also serve turn/river at full depth if you prefer).

> Status: solve-server **built and tested end-to-end** against the real
> TexasSolver binary (a flop solve returns a full per-combo strategy). The HUD
> client call is the documented last step (§4) — it needs your running server.

---

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
node solver-server/server.js
# -> Tengan solve-server on http://127.0.0.1:7333
```

- `TENGAN_SOLVER_BIN` — path to the `console_solver` executable.
- `TENGAN_SOLVER_CWD` — the install dir that contains `resources/` (defaults to the binary's dir).
- `TENGAN_SOLVER_PORT` — default `7333`.

Health check: `curl http://127.0.0.1:7333/` → `{"ok":true,...}`.

## 3. Request protocol

`POST /solve` with JSON:

```json
{
  "board": "Qs,Jh,2h",
  "pot": 6,
  "effStack": 100,
  "oopRange": "TT,99,88,77,66,...,AQo,AJo,KJo,QJo",
  "ipRange":  "AA,KK,QQ,JJ,TT,AKs,...,AKo,AQo,KQo",
  "flopBet": 50, "turnBet": 60, "riverBet": 75,
  "accuracy": 0.5, "maxIter": 100, "threads": 4
}
```

Response: `{ "ms": <solveTime>, "strategy": <TexasSolver dump> }`. The strategy is
the solved tree; the root is OOP's first action (`actions` + per-combo `strategy`).
Navigate `childrens["CHECK"]` / `childrens["BET …"]` to reach the node where the
hero acts, then read the hero's combo.

Tested in-repo against the real binary: `POST /solve` on `Qs,Jh,2h` returned
`CHECK / BET 50% / ALLIN` with a full per-combo strategy.

## 4. HUD client (the last step)

The extension is content-script (isolated world), so it can `fetch` localhost
(add `http://127.0.0.1:7333/*` to host permissions). Wire it in `bridge.js` for
flop spots, gated behind a setting and **heads-up only**, falling back to the
in-engine heuristic when the server is unreachable:

```js
// inside runAdvice, when spot.street === "flop" && headsUp && state.flopSolver:
const body = {
  board: boardStr,                 // "Qs,Jh,2h" from the spot board ids
  pot: spot.pot / 100, effStack: spot.effStack / 100,
  oopRange: heroIsOOP ? heroRangeStr : villRangeStr,
  ipRange:  heroIsOOP ? villRangeStr : heroRangeStr,
  accuracy: 0.5, maxIter: 80
};
fetch("http://127.0.0.1:7333/solve", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then(r => r.json()).then(j => {
     // navigate j.strategy to the hero's decision node by the action so far,
     // read hero's combo freqs, render like the river solver.
  });
```

The range strings come from the same position/pot-type range-builder the
in-engine solver uses (aggressor = seat RFI, 3-bet pots tighter, caller wide,
plus the continue-filter). Reuse that logic so the local solver and the in-engine
solver agree on ranges.

## 5. Notes & limits

- **Latency:** a flop solve is seconds to tens of seconds depending on
  accuracy/iterations/threads. Treat it as an on-demand "deep solve," not an
  auto-solve on every flop.
- **Heads-up only:** TexasSolver (and our range model) is HU; multiway flops stay
  on the heuristic.
- **Range quality caps accuracy:** as everywhere, the solve is only as good as the
  ranges we feed it.
- Turn/river can also be routed here for full depth if you'd rather not use the
  in-engine solver — same protocol, just a 4- or 5-card board.
