#!/usr/bin/env python3
"""Redact secrets from a HAR capture while keeping all game data intact.

Usage:
    python3 tools/scrub_har.py poker.har poker.redacted.har

What it removes:
  - WebSocket JSON fields that carry credentials/session tokens
    (password, auth, loginToken, oldAuth, tfaAuth, accessToken,
     lockdownToken, sessionId, token, jwt, refreshToken, apiKey)
  - Cookie / Authorization HTTP headers and HAR cookie arrays
  - A defense-in-depth global string replace of every literal secret
    value that was found, in case it is echoed elsewhere.

What it keeps:
  - All GameState / Chat / Result / PlayEx / TableState frames and every
    other non-credential field, so the file stays usable as a test fixture.
"""
import json
import re
import sys

SECRET_KEYS = {
    "password", "auth", "logintoken", "oldauth", "tfaauth", "accesstoken",
    "lockdowntoken", "sessionid", "token", "jwt", "refreshtoken", "apikey",
}
SECRET_HEADERS = {"cookie", "set-cookie", "authorization", "x-auth-token",
                  "x-access-token"}
PLACEHOLDER = "REDACTED"


def redact_obj(obj, found):
    """Recursively redact secret-keyed values in a parsed JSON object."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k.lower() in SECRET_KEYS and isinstance(v, str) and v:
                found.add(v)
                out[k] = PLACEHOLDER
            else:
                out[k] = redact_obj(v, found)
        return out
    if isinstance(obj, list):
        return [redact_obj(x, found) for x in obj]
    return obj


def main(src, dst):
    har = json.load(open(src))
    found = set()

    for e in har["log"]["entries"]:
        # WebSocket frames
        for m in e.get("_webSocketMessages", []):
            data = m.get("data")
            if not isinstance(data, str):
                continue
            try:
                j = json.loads(data)
            except Exception:
                continue
            cleaned = redact_obj(j, found)
            if cleaned != j:
                m["data"] = json.dumps(cleaned)
        # HTTP headers + cookies
        for side in ("request", "response"):
            block = e.get(side, {})
            for h in block.get("headers", []):
                if h.get("name", "").lower() in SECRET_HEADERS and h.get("value"):
                    found.add(h["value"])
                    h["value"] = PLACEHOLDER
            if block.get("cookies"):
                for c in block["cookies"]:
                    if c.get("value"):
                        found.add(c["value"])
                        c["value"] = PLACEHOLDER

    # Defense in depth: literal global replace of every secret value found.
    blob = json.dumps(har)
    for secret in sorted(found, key=len, reverse=True):
        if len(secret) >= 8:  # avoid nuking short/common strings
            blob = blob.replace(secret, PLACEHOLDER)
    har = json.loads(blob)

    json.dump(har, open(dst, "w"))
    print(f"Redacted {len(found)} distinct secret value(s).")
    print(f"Wrote {dst}")
    return found


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "poker.har"
    dst = sys.argv[2] if len(sys.argv) > 2 else "poker.redacted.har"
    main(src, dst)
