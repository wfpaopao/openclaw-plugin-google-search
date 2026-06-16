# OpenClaw Plugin: Google Search

[English](./README.md) | [中文](./README.zh-CN.md)

A `google_search` tool for OpenClaw that searches Google **in the local real
browser** (your logged-in session) and returns compact, structured results —
instead of dumping a huge SERP snapshot for the model to parse.

- Most human-like path: a real browser with your cookies, lowest risk of
  triggering Google's bot defenses.
- Cheap: a search costs ~2 browser actions and a few hundred tokens, not 4-5
  tool calls plus multi-thousand-token page snapshots.
- Safe to feed the model: result titles/snippets are wrapped as untrusted
  external content (prompt-injection defense), and the output matches the same
  shape as OpenClaw's native `web_search` providers (e.g. Tavily).

## Quick Examples (What This Plugin Can Do)

Use these prompts directly in Feishu (or other channels) after installation:

- `Search Google for the latest OpenClaw release notes and summarize them.`
- `Use google_search to find the official DeepSeek V4 Pro pricing page.`
- `What are people saying about Claude Opus 4.8 this week? Search and give 5 links.`

## How It Works

1. Opens `google.com/search?q=...&udm=14` (the clean "Web" results view, no AI
   overview / widgets) in a dedicated labeled browser tab.
2. Runs one in-page `evaluate` that extracts the organic results to JSON.
3. Returns only that JSON, then closes the search tab and reaps Google's
   transient session-sync tabs so nothing is left behind.

It drives the existing `browser` plugin through the OpenClaw CLI, so it stays
decoupled from OpenClaw internals and reuses the browser session you already
trust. The browser process is kept warm by default (shared resource, warm
login = low risk-control); set `closeBrowserAfterSearch` to also stop it.

## Requirements

- OpenClaw installed and working.
- The `browser` plugin enabled, with a usable browser profile (the plugin
  auto-starts the browser on demand).

## Install

```sh
openclaw plugins install /path/to/openclaw-plugin-google-search --link
openclaw plugins enable google-search
# add "google_search" to the agent's tools.alsoAllow, then restart the gateway
openclaw gateway restart
```

`--link` points OpenClaw at the source directory, so edits here load on the
next gateway restart.

## Configuration (optional)

Set under `plugins.entries.google-search.config` in `openclaw.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultLang` | `"en"` | Google interface language (`hl`), e.g. `"zh-CN"`. |
| `region` | — | Google region (`gl`), e.g. `"us"`, `"cn"`. |
| `browserProfile` | default profile | OpenClaw browser profile to use. |
| `maxResultsCap` | `10` | Hard cap on results returned to the model. |
| `closeTabAfterSearch` | `true` | Close the search tab (and reap noise tabs) after each search. |
| `closeBrowserAfterSearch` | `false` | Also stop the whole browser after each search. |

## Tool Parameters

`query` (required), `num` (1-20, default 10), `hl`, `gl`.

## Output

```jsonc
{
  "query": "deepseek v4 pro",
  "provider": "google",
  "count": 3,
  "tookMs": 9308,
  "externalContent": { "untrusted": true, "source": "web_search", "provider": "google", "wrapped": true },
  "results": [
    { "title": "<<<EXTERNAL_UNTRUSTED_CONTENT ...>>> ...", "url": "https://...", "snippet": "<<<...>>> ..." }
  ]
}
```

## License

MIT — see [LICENSE](./LICENSE).
