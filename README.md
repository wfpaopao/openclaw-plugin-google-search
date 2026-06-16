# openclaw-plugin-google-search

Adds a `google_search` tool to OpenClaw that searches Google **in the local
real browser** (your logged-in session, human-like, low risk-control) and
returns compact structured results — `{title, url, snippet}` — instead of
dumping a huge SERP snapshot for the model to parse.

## How it works

1. Navigates the OpenClaw browser to `google.com/search?q=...&udm=14` (the clean
   "Web" results view, no AI overview/widgets).
2. Runs one in-page `evaluate` that extracts the organic results to JSON.
3. Returns only that JSON (a few hundred tokens), so a search costs ~2 browser
   actions instead of 4-5 tool calls + multi-thousand-token snapshots.

It drives the existing `browser` plugin via the OpenClaw CLI, so it stays
decoupled from OpenClaw internals and reuses the browser session you already
trust. Requires the `browser` plugin enabled and a browser profile available.

## Install

```sh
openclaw plugins install /path/to/openclaw-plugin-google-search --link
openclaw plugins enable google-search
# then add "google_search" to the agent's tool allowlist and restart the gateway
```

## Config (optional)

```jsonc
{ "defaultLang": "en", "region": "us", "browserProfile": "openclaw", "maxResultsCap": 10 }
```

## Tool params

`query` (required), `num` (1-20, default 10), `hl`, `gl`.
