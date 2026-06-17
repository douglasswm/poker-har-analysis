# Poker HAR Analysis Report

Source: `poker.har`

Captured game websocket: `wss://fs2.skp223817.org/front`

Capture window: 2026-06-06 17:43:45Z to about 17:54:37Z

## Executive Summary

The HAR contains enough information to build a Chrome extension that passively tracks the user's live poker table state and derives analytics from observed messages.

The useful data stream is the `GameState` websocket message. It includes table id, game id, blinds, seats, stacks, current bets, positions, board cards, hero hole cards, current hand evaluation, pot size, timer state, and per-hand progress. It does not expose opponents' private cards during normal play; remote hole cards appear as `"-1;-1"` until showdown/replay contexts.

The extension should be built as a passive observer:

- Hook page-created `WebSocket` objects from an injected page-world script.
- Copy inbound and outbound JSON frames into the extension.
- Parse only poker table messages.
- Maintain an in-memory hand model keyed by `gameState.gi`.
- Persist derived hand histories and player stats to `chrome.storage.local` or IndexedDB.
- Never send poker actions or alter websocket payloads.

This is important both technically and operationally. The HAR includes auth tokens and live command messages, so the extension should avoid retaining secrets and should not replay or modify traffic.

## HAR Inventory

The HAR has 4 websocket entries:

| URL | Frames | Purpose |
| --- | ---: | --- |
| `wss://stake.com/_api/websockets` | 129 | Stake platform traffic |
| `wss://stake.com/_api/websockets` | 136 | Stake platform traffic |
| `wss://nexus-websocket-a.intercom.io/...` | 56 | Intercom/support traffic |
| `wss://fs2.skp223817.org/front` | 516 | Poker game traffic |

For the game websocket:

- Total frames: 516
- Received frames: 434
- Sent frames: 82
- JSON frames: 516

Top message types:

| Message type | Count | Direction |
| --- | ---: | --- |
| `GameState` | 254 | receive |
| `Chat` | 79 | receive |
| `Result` | 42 | receive |
| `PlayerCommand` | 19 | send |
| `TableEvent` | 13 | receive |
| `GetTableState` / `TableState` | 9 each | send/receive |
| `PlayEx` | 7 | send |
| `HandsListForReplay` | 2 | receive |
| `GameReplay` | 1 | receive |

## Connection Flow

The browser sends setup and authentication messages first:

- `ClientVersion`
- `SetDeviceLabel`
- `GetClientConfig`
- `Login`
- `GetAllowedPlayerPermissions`
- `GetBalance`
- `GetPlayerTablesByPlayerId`
- `SelectTable`
- `SitDown`
- `GetTableState`
- `PlayerCommand`

The important point for an extension is that it does not need to establish its own websocket connection. It can observe the page's existing websocket and avoid handling auth entirely.

## Core `GameState` Model

Observed top-level `gameState` fields:

| Field | Meaning / interpretation |
| --- | --- |
| `ti` | Table id. In this HAR: `861007`. |
| `gi` | Hand/game id. Changes on each new hand. |
| `gt` | Game type enum. In this HAR: `72`. |
| `pt` | Poker/table variant enum. In this HAR: `85`. |
| `sbv` | Small blind value. In this HAR: `1`. |
| `bbv` | Big blind value. In this HAR: `2`. |
| `ts` | Table/hand lifecycle state. Seen as active/result/cleanup states. |
| `sfgs` | Seconds since game start or phase start. Often negative in live snapshots. |
| `d` | Dealer/board/pot object. |
| `s` | Seat array. Usually 9 seats. |
| `t` | Timer object. |
| `m` | Table metadata: positions, action index, round. |
| `ss` | Hero hand-strength summary. |
| `sp`, `spr`, `lrn`, `aa`, `f` | Internal flags/arrays; not needed for first analytics version. |

### Board / Pot Object `d`

Observed fields:

| Field | Meaning |
| --- | --- |
| `c` | Community cards as semicolon-separated card ids, e.g. `"20;16;31"` for flop. |
| `p` | Pot amount in table units/chips. |
| `r` | Result/showdown flag or result code; useful as an end-of-hand marker but not fully decoded. |

Example:

```json
{
  "c": "20;16;31;26",
  "p": 145
}
```

### Table Metadata `m`

Observed fields:

| Field | Meaning / interpretation |
| --- | --- |
| `r` | Betting street/round. `1` appears preflop, `2` flop, `3` turn. |
| `nr` | Raise/action sequence counter within street. |
| `di` | Dealer button seat index. |
| `sb` | Small blind seat index. |
| `bb` | Big blind seat index. |
| `ci` | Current acting seat index. |
| `ai` | Last actor or animation target seat index. |
| `f` | Internal table flag. |
| `cci` | Internal/current command index; often `255`. |

### Timer Object `t`

Observed fields:

| Field | Meaning / interpretation |
| --- | --- |
| `tm` | Total decision timer for current action. |
| `tr` | Time remaining. |
| `ts` | Time bank or session timer field. |
| `bt`, `bd`, `tb`, `stb`, `tpt`, `let` | Internal timer fields; `let` is likely last event timestamp. |

### Seat Object `s[i]`

Observed fields:

| Field | Meaning / interpretation |
| --- | --- |
| `i` | Player id. |
| `n` | Internal player name. |
| `dn` | Display name. |
| `c` | Stack/chips remaining. |
| `b` | Current bet/contribution shown for that street/action. |
| `d` | Hidden remote hole-card placeholder, usually `"-1;-1"`. |
| `dc` | Visible dealt cards for hero/local user. |
| `s` | Seat/player state enum. |
| `la` | Last action enum. |
| `f`, `f2` | Internal bit flags. |
| `a` | Avatar id. |
| `r` | Player rating/rank/real-player marker. |
| `ec` | Connection/client state. |
| `spt`, `attrs`, `wc`, `hcnu`, `hcmu`, `cf` | Internal or cosmetic fields. |

Hero user in the capture:

- Player id: `16507`
- Display name: `icemilo`

Hero hole cards are visible in `s[i].dc`, for example:

```json
{
  "i": 16507,
  "dn": "icemilo",
  "dc": "51;41"
}
```

Remote players' private cards are hidden during live play:

```json
{
  "d": "-1;-1"
}
```

### Hero Hand Summary `ss`

Observed fields:

| Field | Meaning |
| --- | --- |
| `hc` | Human-readable current hero hand, e.g. `"High Card:  A"`. |
| `hcm` | Encoded hand-card mapping. Useful for UI highlighting, but not yet fully decoded. |

Example:

```json
{
  "hc": "High Card:  A",
  "hcm": "J.51;41;31;26;20.H.H"
}
```

## Action Messages

The user's explicit actions are sent as `PlayEx` messages.

Observed `PlayEx` frames:

| Hand id | Sent action | Funds | Likely meaning |
| ---: | ---: | ---: | --- |
| `81037099` | `1` | `0` | Fold/default fold |
| `81037172` | `1` | `0` | Fold/default fold |
| `81037456` | `9` | `6` | Call/match to amount |
| `81037456` | `9` | `8` | Call/match additional amount |
| `81037456` | `8` | `50` | Bet/raise to amount |
| `81037456` | `9` | `100` | Call/match to amount |
| `81037456` | `1` | `0` | Fold |

Action enum inference:

| Enum | Likely action |
| ---: | --- |
| `1` | Fold or default fold/check-fold |
| `8` | Bet/raise |
| `9` | Call or match amount |

The same enum appears in received seat `la` values after the action is accepted. For example, after hero sends `{"action":8,"funds":50}`, the next state shows hero with `b:50`, `c` reduced by 50, and `la:8`.

## Hand Summaries From Capture

The capture includes live state for 8 hands.

| Hand id | States | Hero cards | Hero stack | Boards seen | Pots seen | Result signal |
| ---: | ---: | --- | --- | --- | --- | --- |
| `81037016` | 28 | `15;22` | `385 -> 385` | flop/turn/river `49;47;36;31;48` | `10`, `18` | `georgiina27` wins `0.09`, cards not shown |
| `81037099` | 32 | `8;27` | `385 -> 385` | `43;24;45;48` | `9`, `13`, `25` | `georgiina27` wins `0.12`, cards not shown |
| `81037172` | 38 | `27;46` | `385 -> 383` | flop `13;38;17` | `47`, `63`, `110` | `K0rbenDalas` wins `0.59`, cards not shown |
| `81037256` | 35 | `16;20` | `383 -> 382` | flop `35;45;48` | `45`, `79` | `Freshnesss` wins `0.42`, cards not shown |
| `81037327` | 29 | none visible | `382 -> 382` | `16;48;2;50` | `7`, `15` | `Rostommia1966` wins `0.06` with One Pair: As |
| `81037398` | 28 | `46;43` | `382 -> 382` | none in live states | `18`, `114` | `Rostommia1966` wins `0.18`, cards not shown |
| `81037456` | 40 | `51;41` | `382 -> 218` | `20;16;31;26` | `45`, `145`, `345`, `431` | `Rostommia1966` wins `3.21`, cards not shown |
| `81037548` | 24 | `8;44` | `218 -> 218` | flop `50;2;35` | `6` | hand incomplete in capture |

Notes:

- The hand-history API also returned older hands through `HandsListForReplay`.
- The capture includes one `GameReplay` response for `81037398`, which is very useful for reverse-engineering event/action transitions because replay snapshots include compact state deltas.

## Useful Derived Analytics

A first version of the extension can support these analytics without fully decoding every enum:

### Session Analytics

- Current stack and buy-in-adjusted profit/loss.
- Hands observed.
- Voluntarily put money in pot approximation.
- Preflop raise/call/fold counts.
- Postflop bet/call/fold counts.
- Time-bank/default-action warnings.
- Biggest pots played.
- Hands reaching flop/turn/river.

### Table Analytics

- Seat map with names, stacks, current bets, button, blinds, and current actor.
- Per-opponent observed tendencies:
  - Fold count.
  - Call/check count.
  - Bet/raise count.
  - Timeout/default action count.
  - Average decision time when `t.tr` transitions are available.
- Pot growth by street.
- Player stack changes by hand.

### Hero Decision Context

At each decision point, the extension can show:

- Hero hole cards as raw card ids initially.
- Board raw ids.
- Pot size.
- Amount to call, inferred from max current `b` minus hero current `b`.
- Street from `m.r`.
- Current acting seat from `m.ci`.
- Hero hand text from `ss.hc`.
- Previous aggressor from most recent `la:8` or high `b`.

### Replay/History Analytics

The `HandsListForReplay` response exposes a compact history:

- `gid`: game id.
- `cds`: hero cards.
- `bet`: hero invested amount in some hands.
- `pot`: final pot in some hands.
- `isw`: hero won.
- `hcomb`: final hero hand combination.
- `she`: stack after hand or stack at hand end.
- `games[].c`: final board cards.
- `games[].s` / `games[].e`: hand start/end timestamps.

This is strong enough to populate a historical session panel without waiting for all live states to be captured.

## Extension Architecture

### 1. Page-World WebSocket Hook

Chrome content scripts run in an isolated world, so the extension should inject a page-world script that wraps `window.WebSocket`.

The hook should:

- Preserve the native WebSocket constructor and prototype.
- Log `message` events.
- Wrap `send`.
- Dispatch sanitized frames to the content script with `window.postMessage`.
- Never alter outbound messages.

Data to forward:

```ts
type CapturedFrame = {
  direction: "in" | "out";
  time: number;
  url: string;
  data: string;
};
```

### 2. Content Script Parser

The content script should:

- Accept only frames from `wss://fs2.skp223817.org/front`.
- Parse JSON safely.
- Ignore auth/setup messages except for non-sensitive metadata.
- Forward parsed poker messages to the extension runtime.

Do not persist:

- `Login.password`
- `AuthState.auth`
- `UpdateLoginToken.loginToken`
- cookies
- websocket request headers

### 3. Background Service Worker

The service worker should maintain:

```ts
type SessionState = {
  heroPlayerId?: number;
  currentTableId?: number;
  currentHandId?: number;
  hands: Record<number, HandState>;
  players: Record<number, PlayerStats>;
};
```

Use IndexedDB for hand histories if analytics grow beyond a simple current-session HUD.

### 4. Overlay UI

Use a lightweight in-page overlay or extension side panel:

- Current hand panel.
- Hero stack and session P/L.
- Pot and call amount.
- Seat/player stats.
- Hand history list.

Avoid obscuring table controls.

## Parser Skeleton

```ts
function parsePokerFrame(frame: CapturedFrame): PokerMessage | null {
  if (!frame.url.includes("fs2.skp223817.org/front")) return null;

  let msg: any;
  try {
    msg = JSON.parse(frame.data);
  } catch {
    return null;
  }

  if (!msg || typeof msg !== "object") return null;

  switch (msg.t) {
    case "GameState":
    case "Chat":
    case "TableState":
    case "HandsListForReplay":
    case "GameReplay":
    case "PlayEx":
      return msg;
    default:
      return null;
  }
}
```

```ts
function applyGameState(state: SessionState, msg: any) {
  const gs = msg.gameState;
  if (!gs || !gs.gi) return;

  state.currentTableId = gs.ti;
  state.currentHandId = gs.gi;

  const hand = state.hands[gs.gi] ??= {
    id: gs.gi,
    tableId: gs.ti,
    blinds: { sb: gs.sbv, bb: gs.bbv },
    statesSeen: 0,
    boards: [],
    pots: [],
    actions: [],
    seats: {}
  };

  hand.statesSeen += 1;

  if (gs.d?.c) hand.board = gs.d.c.split(";").map(Number);
  if (typeof gs.d?.p === "number") hand.pot = gs.d.p;

  hand.street = gs.m?.r;
  hand.buttonSeat = gs.m?.di;
  hand.smallBlindSeat = gs.m?.sb;
  hand.bigBlindSeat = gs.m?.bb;
  hand.currentSeat = gs.m?.ci;

  for (let seatIndex = 0; seatIndex < (gs.s ?? []).length; seatIndex++) {
    const seat = gs.s[seatIndex];
    if (!seat || typeof seat !== "object") continue;

    hand.seats[seatIndex] = {
      playerId: seat.i,
      name: seat.dn,
      stack: seat.c,
      bet: seat.b ?? 0,
      lastAction: seat.la,
      status: seat.s,
      heroCards: seat.dc ? seat.dc.split(";").map(Number) : undefined
    };
  }
}
```

## Open Questions / Reverse Engineering Still Needed

1. Card id mapping.

   The supplied community-card anchors are:

   - `16 = 6CLUBS`
   - `17 = 6DIAMONDS`
   - `5 = 3DIAMONDS`

   These imply a `0..51` deck id scheme where ranks advance every four ids:

   ```ts
   rankIndex = Math.floor(cardId / 4);
   suitIndex = cardId % 4;
   ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
   suits = ["CLUBS", "DIAMONDS", "HEARTS", "SPADES"];
   ```

   `CLUBS` and `DIAMONDS` are confirmed. `HEARTS` and `SPADES` are extrapolated into the two remaining suit slots and should be verified with one visual card sample.

   Full extrapolated map:

   | Id | Card | Id | Card | Id | Card | Id | Card |
   | ---: | --- | ---: | --- | ---: | --- | ---: | --- |
   | 0 | 2CLUBS | 1 | 2DIAMONDS | 2 | 2HEARTS | 3 | 2SPADES |
   | 4 | 3CLUBS | 5 | 3DIAMONDS | 6 | 3HEARTS | 7 | 3SPADES |
   | 8 | 4CLUBS | 9 | 4DIAMONDS | 10 | 4HEARTS | 11 | 4SPADES |
   | 12 | 5CLUBS | 13 | 5DIAMONDS | 14 | 5HEARTS | 15 | 5SPADES |
   | 16 | 6CLUBS | 17 | 6DIAMONDS | 18 | 6HEARTS | 19 | 6SPADES |
   | 20 | 7CLUBS | 21 | 7DIAMONDS | 22 | 7HEARTS | 23 | 7SPADES |
   | 24 | 8CLUBS | 25 | 8DIAMONDS | 26 | 8HEARTS | 27 | 8SPADES |
   | 28 | 9CLUBS | 29 | 9DIAMONDS | 30 | 9HEARTS | 31 | 9SPADES |
   | 32 | 10CLUBS | 33 | 10DIAMONDS | 34 | 10HEARTS | 35 | 10SPADES |
   | 36 | JCLUBS | 37 | JDIAMONDS | 38 | JHEARTS | 39 | JSPADES |
   | 40 | QCLUBS | 41 | QDIAMONDS | 42 | QHEARTS | 43 | QSPADES |
   | 44 | KCLUBS | 45 | KDIAMONDS | 46 | KHEARTS | 47 | KSPADES |
   | 48 | ACLUBS | 49 | ADIAMONDS | 50 | AHEARTS | 51 | ASPADES |

   Decoder for the extension:

   ```ts
   const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
   const SUITS = ["CLUBS", "DIAMONDS", "HEARTS", "SPADES"] as const;

   function decodeCardId(cardId: number) {
     if (!Number.isInteger(cardId) || cardId < 0 || cardId > 51) {
       throw new Error(`Invalid card id: ${cardId}`);
     }

     const rank = RANKS[Math.floor(cardId / 4)];
     const suit = SUITS[cardId % 4];

     return {
       id: cardId,
       rank,
       suit,
       label: `${rank}${suit}`
     };
   }
   ```

2. Full action enum dictionary.

   Confident:

   - `PlayEx.action = 1`: fold/default fold.
   - `PlayEx.action = 8`: bet/raise.
   - `PlayEx.action = 9`: call/match.

   Still needs more samples:

   - check
   - small blind post
   - big blind post
   - all-in
   - timeout/default action

3. Seat `s` status enum.

   It changes reliably with player state, but the values are not yet fully named. The extension can treat it as an internal enum and derive human-readable actions from `la`, `b`, stack deltas, and chat messages.

4. Table lifecycle `ts`.

   Values mark active/result/cleanup states. Use `gi` changes and dealer chat `"New hand started"` / `"Deal done"` as safer hand lifecycle markers for v1.

## Implementation Recommendation

Build the extension in this order:

1. Passive websocket capture with secret redaction.
2. `GameState` parser and current-hand store.
3. Minimal overlay showing table id, hand id, hero cards raw ids, board raw ids, pot, stack, current actor, and `ss.hc`.
4. Hand history persistence keyed by `gi`.
5. Player stats from stack/bet/action deltas.
6. Replay/history ingestion from `HandsListForReplay`.
7. Card id mapper and richer poker-specific stats after more captures.

The extension should avoid automated decisioning and automated play. It can present analytics from information already visible to the user, but it should not click buttons, send `PlayEx`, or replay websocket traffic.
