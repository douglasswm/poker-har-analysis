# Security notes

## The raw capture contains live credentials

`poker.har` was recorded from a real session and contains **replayable secrets**:

| Secret | Where | Risk |
| --- | --- | --- |
| Stake account `accessToken` (128 hex) | `wss://stake.com/_api/websockets` `connection_init` | Full account session token |
| Stake `lockdownToken` | same frame | Session lockdown token |
| Poker `password` / `auth` / `loginToken` | `wss://fs2.skp223817.org/front` Login/AuthState | Game session auth (token doubles as password) |

**Treat all of these as compromised.** They are in git history. Recommended actions:

1. Log out / re-authenticate on Stake and the poker client so the captured tokens are rotated server-side.
2. Change the account password if the same value is reused anywhere.
3. Do not share `poker.har` as-is.

## What is safe to use

`poker.redacted.har` has every secret replaced with `REDACTED` while keeping
all 516 game frames intact. Use it as the test fixture for the parser and HUD.

Regenerate it any time with:

```bash
python3 tools/scrub_har.py poker.har poker.redacted.har
```

`poker.har` is listed in `.gitignore` so the raw capture is not committed again.

## Build guardrails (HUD extension)

The tracker must stay a **passive observer**:

- Read the page's existing WebSocket only; never open its own game connection.
- Never send `PlayEx` / `PlayerCommand` or alter outbound frames.
- No automated decisioning or auto-play.
- Never persist `password`, `auth`, `loginToken`, `accessToken`, cookies, or
  request headers.
- Display only information already visible to the player.

Note: third-party trackers/HUDs typically violate real-money poker room Terms
of Service. Understand the account risk before running this live.
