# Tengan Poker HUD (Chrome extension)

A **passive, read-only** Chrome extension that captures the Stake Poker game
websocket (`front`) — including frames inside the cross-origin game iframe that
ordinary page scripts can't reach — and shows them in an in-page overlay with
both a **raw frame feed** and a **decoded current-hand panel**.

It is an observer only. It never sends game actions, never modifies or replays
traffic, and redacts credentials before they reach the UI.

## What it does

- Hooks `window.WebSocket` in the page's main world, in **every frame** (incl.
  the `skp223817.org` game iframe), at `document_start`.
- Forwards a copy of each inbound/outbound **string** frame to an isolated-world
  bridge, which **redacts secrets** (`password`, `auth`, `loginToken`,
  `accessToken`, `lockdownToken`, …) and relays child-frame frames up to the top
  frame.
- Renders an overlay with:
  - a connection filter (`front` / all / stake / intercom),
  - a live log of frames (timestamp, direction, message type, click to expand),
  - pause / clear / **export-to-JSON**,
  - a decoded hand panel: table id, hand id, street, board (decoded cards), pot,
    and a seat table with **positions** (SB/BB/BTN/UTG…), stacks, bets, each
    seat's last action, and the hero's own cards when seated.
  - a per-player **action feed** for the current hand, grouped by street:
    blind posts, folds, checks, calls (with amount), bets/raises (with the
    raise-to amount), and timeouts — derived by diffing `la`/`b` across frames.
    Only clean labels are shown; raw `la` numbers are never displayed.
  - a **winner banner** when a hand ends (winner, amount, winning hand type),
    plus the **showdown** hands that were revealed.
  - a **Players tab** with per-opponent stats accumulated across the session.

## Players tab & bluffing rate

The Players tab tracks every player across the session and computes:

- **VPIP** — % of hands they voluntarily put money in preflop.
- **PFR** — % of hands they raised preflop.
- **AF** — aggression factor = (bets + raises) / calls.
- **WTSD** — % of flops-seen that reached showdown.
- **Bluff%** — a *shown-cards* river bluff rate: of the hands where the player
  made the last bet/raise on the **river** and their cards were revealed at
  showdown, the % where they showed **no pair** (a clear bluff). The sample size
  `n` is shown next to it, because a meaningful bluff rate needs many shown
  showdowns. This is only computable because Stake reveals showdown hands in the
  stream (`d` field at `m.r` 5–6); we evaluate the 7-card hand with the engine's
  `handCategory` to classify it.

Click a player row to expand their **per-street decision history** (their line on
preflop/flop/turn/river for recent hands, with shown cards and result).

Accuracy note: the action feed and stats are reconstructed by diffing periodic
`GameState` snapshots, so on **sparse captures** (few frames per hand) some
actions can be missed or approximated. Denser captures → more accurate stats.
Folds are detected by `la===1` (the seat-state `s` field is *not* a fold flag).

### Last-action (`la`) code map

Reverse-engineered from chip deltas at each action instant across three captures
(28 hands, $0.01/$0.02 and $0.25/$0.50 tables; see `parser.js`):

| la | meaning | la | meaning |
|----|---------|----|---------|
| 1  | fold      | 11 | muck (showdown end, cards not shown) |
| 2  | check     | 13 | waiting (seated, waiting for the button) |
| 3  | call      | 16 | uncalled-bet return / side-pot (result) |
| 6  | post SB   | 25 | call |
| 7  | post BB   | 26 | timeout (default action) |
| 8  | bet/raise | 9  | call (incl. large/all-in) |
| 10 | showdown / wins pot (result) | | |

Note: betting aggression is all `la=8`; the feed splits bet vs. raise by chip
movement. Codes **10, 11, 16** fire only in the result phases (`m.r` 5–6:
showdown / pot-award) — they are *not* betting actions and are excluded from the
feed. (An earlier pass mislabeled 10/16 as bet/raise from award amounts captured
at the result phase; corrected with the 13-hand capture.)

The feed classifies primarily by **chip movement** (matched the bet = call,
exceeded it = raise, none = check), using `la` only to disambiguate fold / posts
/ timeout / showdown / muck / waiting.

**Still unmapped** (never observed): `0, 4, 5, 12, 14, 15, 17–24`, plus anything
≥27. Likely all-in variants, **straddle**, ante/dead-blind, explicit show-cards,
or sit-out. The parser console-logs any unmapped code when it first appears.

The parser logs any unmapped `la` code to the console once (with street / bet /
state context) — so the next time a straddle, ante, or all-in code appears it's
flagged for mapping. Until then, an unknown *betting* code still renders
correctly (chip-movement classifier); a straddle currently shows as a preflop
bet/raise.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this `poker-hud-extension/` folder.
4. Open `https://stake.com/casino/games/poker` and sit at / open a table.
   The overlay appears top-right. Drag it by the header; click **—** to minimize.

## Important: the game-iframe domain may change

The poker game loads from an obfuscated host (observed: `fs2.skp223817.org`).
If Stake rotates that domain, the hook won't run in the iframe and you'll only
see the `stake` socket. Fix: edit the two `matches` arrays in `manifest.json`
to add the new domain (e.g. `"*://*.NEWDOMAIN.org/*"`), then reload the
extension. You can find the current host in DevTools → Network → the `front`
entry.

## Verify it offline

`node test/parser.test.js` replays the redacted capture
(`../poker-har-analysis/poker.redacted.har`) through the decoder and checks card
decoding, positions, and board sanity. Expected: `ALL CHECKS PASSED ✅`.

## GTO advisor (⚡ button)

The overlay includes a **GTO engine written from scratch in TypeScript**, using
the same algorithm as bupticybee/TexasSolver: **Discounted CFR** (regret
matching, DCFR discounting α=1.5/β=0.5/γ=2/θ=0.9, average strategy,
best-response exploitability). It runs entirely in the extension — no native
binary, no server.

The overlay is a draggable card with a header (⚡ advise, ▁ minimize, ✕ close)
and three tabs:

- **Table** — the GTO advice panel + decoded hand (board, pot, seat table).
- **Actions** — the per-player action feed for the current hand.
- **Log** — the raw frame feed with the connection filter + pause/clear/export.

Closing with **✕** hides the HUD and leaves a small ♠ launcher (top-right) to
reopen it. All money is shown in **dollars** — chip units are cents (verified
across stake levels: bb=2 → $0.02, bb=50 → $0.50, bb=2,500,000 → $25,000), so
the conversion is always `units ÷ 100`.

**Hero selector ("You"):** at the top of the Table tab, pick which seat is you.
- *Auto* uses the seat whose cards are visible (your own).
- Pick any other seat to study it. If that seat's cards are hidden, two card
  pickers appear so you can enter the hand to solve. (Seats with visible cards
  are marked ✦.)

The advisor recommends **fold / check / call / bet / raise / all-in** with sizing.
All-in is offered explicitly and is also labeled when a normal bet/raise is
capped to the stack. Preflop, short stacks (≤20bb) get shove recommendations.

Click **⚡** to get a read on the current spot:

- **Preflop** — instant 6-max chart lookup (raise/call/fold + size).
- **Flop** — instant range-aware heuristic, upgraded to native TexasSolver when
  the local solve-server is enabled and reachable.
- **Turn** — off-thread two-street Discounted-CFR in-engine, or native
  TexasSolver when the solver toggle is on.
- **River** — off-thread Discounted-CFR in-engine, or native TexasSolver when
  enabled, returning action frequencies and solved exploitability.

The engine is verified: `cd engine && npm test` checks the hand evaluator, the
GTO-math formulas, and CFR convergence (a polarized river converges to ~2% of
pot and reproduces the ⅓ bluff-to-value ratio).

### Dev workflow (run from this folder)

```bash
npm install        # once
npm run dev        # watch: rebuilds src/engine.bundle.js on every TS change
npm run build      # one-off production bundle
npm test           # engine CFR/math/evaluator tests + parser HAR test
npm run typecheck  # tsc --noEmit
npm run solver:install
npm run solver     # local native TexasSolver HTTP server, reads .solver.env
npm run solver:check
```

`npm run dev` watches `engine/src/*.ts` and writes `src/engine.bundle.js`. After
a rebuild, hit **Reload** on the extension in `chrome://extensions`.

Source layout: `engine/` holds the TypeScript source; `src/` is the loadable
extension (content scripts + the built `engine.bundle.js`). You only run npm
from this root folder.

For native postflop solves on macOS, run `npm run solver:install` once, then run
`npm run solver` before using the HUD's solver toggle. Manual installs can still
use `.solver.env.example` as the template.

### Honest limitations of the advisor

- The solver needs **both players' ranges**; range diagnostics in the HUD show
  the position, pot type, combo counts, and action filters used. Treat outputs as
  GTO for assumed ranges, not ground truth.
- Native postflop solves require the local solve-server. If it is off,
  unreachable, or times out, the HUD keeps the instant in-engine fallback and
  labels the source/status. Run `npm run solver:check` to distinguish "server
  not running" from a missing `console_solver`/`resources/` configuration.
- Multiway pots are heuristic/equity-based, not true GTO solves.
- This is the opposite of solver-exact products like PioSOLVER/GTO Wizard — it's
  a compact, transparent re-implementation for research.

## Files

- `manifest.json` — MV3; engine bundle + two content scripts (MAIN-world hook + isolated bridge).
- `src/hook.js` — passive `WebSocket` wrapper (main world, all frames).
- `src/bridge.js` — redaction, child→top relay, store, overlay UI, and advisor panel.
- `src/parser.js` — protocol decode (cards, GameState, positions, Chat).
- `src/engine.bundle.js` — built GTO engine (from `engine/`).
- `src/overlay.css` — overlay styling.
- `test/parser.test.js` — offline parser validation against the HAR.
- `engine/` — TypeScript GTO engine source:
  - `src/evaluator.ts` — 7-card hand evaluator.
  - `src/cfr.ts` — Discounted-CFR river solver + best-response exploitability.
  - `src/gtomath.ts` — pot odds / MDF / α / bluff-to-value / SPR.
  - `src/ranges.ts` — preflop chart + range helpers.
  - `src/spot.ts` — GameState → decision spot.
  - `src/advisor.ts` — routes preflop/flop-turn/river to chart/math/solver.
  - `test/run.ts` — engine test suite.

## Scope, privacy, and fair-use

- **Read-only by design.** No `PlayEx`/`PlayerCommand` is ever sent; outbound
  frames are observed and passed through unchanged. It shows only information
  already visible to you — opponents' hole cards stay hidden (`-1;-1`) until
  showdown, exactly as the server sends them.
- **Secrets are redacted** in-memory before display/export; auth tokens are
  never stored.
- **Terms of Service:** real-money poker rooms generally prohibit third-party
  tools and HUDs of any kind. Running this against a live real-money account may
  violate Stake's ToS and risk the account. Understand that before using it;
  this is provided for protocol study and personal experimentation.
