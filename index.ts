import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult, wrapWebContent } from "openclaw/plugin-sdk/provider-web-search";

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "google-search";
const TOOL_NAME = "google_search";
const PROVIDER = "google";
const TAB_LABEL = "openclaw-google-search";
// Mark extracted text as untrusted web content for the harness's prompt-injection
// defenses — same convention OpenClaw's native web_search providers use.
const WEB_SOURCE = "web_search";

// --- browser CLI plumbing ----------------------------------------------------
// The plugin runs inside the gateway process. We drive the existing `browser`
// tool by shelling out to the same openclaw CLI, which connects back to the
// running gateway. This keeps us decoupled from openclaw's internal browser API
// (only hashed-bundle exports exist) and reuses the browser session the user
// already trusts.
function cliInvocation(): { cmd: string; pre: string[] } {
  const entry = process.argv[1];
  if (entry && entry.includes("openclaw")) return { cmd: process.execPath, pre: [entry] };
  return { cmd: "openclaw", pre: [] };
}

async function runBrowser(args: string[]): Promise<string> {
  const { cmd, pre } = cliInvocation();
  const { stdout } = await execFileAsync(cmd, [...pre, "browser", ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

// `browser evaluate` prints its JSON return value, pretty-printed, at the TAIL
// of stdout after un-suppressable doctor/migration boxes. Those box lines start
// with │ ◇ ├ ╯; the JSON body's inner lines are indented. So the last line that
// *starts* with `[`/`{` and parses to EOF is our value.
function parseTrailingJson(stdout: string): unknown {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const head = lines[i].trimEnd();
    if (head.startsWith("[") || head.startsWith("{")) {
      try {
        return JSON.parse(lines.slice(i).join("\n").trim());
      } catch {
        /* keep scanning upward */
      }
    }
  }
  throw new Error(
    `google_search: could not parse browser evaluate output. Tail:\n${stdout.slice(-400)}`,
  );
}

// Runs entirely in the page. No regex backslashes so it survives string
// embedding. Guards that we're actually on a Google results page (so a stolen
// active tab yields [] and triggers a retry rather than garbage). Targets the
// clean `udm=14` "Web" results layout.
const EXTRACT_FN = `() => {
  if (!/\\.google\\./.test(location.hostname) || !location.pathname.startsWith('/search')) return [];
  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('#search a:has(h3)');
  for (const a of anchors) {
    const h3 = a.querySelector('h3');
    if (!h3) continue;
    const url = a.href;
    if (!url || seen.has(url)) continue;
    const box = a.closest('[data-hveid]') || a.parentElement;
    let snippet = '';
    if (box) {
      const s = box.querySelector('.VwiC3b') || box.querySelector('div[role="text"]') || box.querySelector('div[style*="line-clamp"]');
      if (s) snippet = s.innerText || '';
    }
    snippet = snippet.trim();
    if (snippet.endsWith('Read more')) snippet = snippet.slice(0, -'Read more'.length).trim();
    seen.add(url);
    out.push({ title: (h3.innerText || '').trim(), url, snippet });
  }
  return out;
}`; // doubled backslashes above resolve to single \ in the string (valid regex)

// Distinguishes a consent wall / CAPTCHA from a generic empty result so the
// model gets an actionable note instead of a silent zero.
const STATUS_FN = `() => {
  const t = (document.body && document.body.innerText || '').slice(0, 4000);
  const captcha = !!document.querySelector('form[action*="sorry"], #captcha, iframe[src*="recaptcha"]')
    || /unusual traffic|not a robot|systems have detected/i.test(t);
  const consent = !!document.querySelector('form[action*="consent"]')
    || /before you continue|consent.google/i.test(location.href + ' ' + t);
  return { captcha: captcha, consent: consent, url: location.href, title: document.title };
}`;

type RawResult = { title: string; url: string; snippet: string };

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function readInt(params: Record<string, unknown>, key: string): number | undefined {
  const v = params?.[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function readBool(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params?.[key];
  return typeof v === "boolean" ? v : undefined;
}

function buildSearchUrl(query: string, fetchCount: number, hl: string, gl?: string): string {
  const params = new URLSearchParams({ q: query, num: String(fetchCount), hl, udm: "14" });
  if (gl) params.set("gl", gl);
  return `https://www.google.com/search?${params.toString()}`;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createGoogleSearchTool(api: any) {
  const cfg = (api?.pluginConfig ?? {}) as Record<string, unknown>;
  const defaultLang = readString(cfg, "defaultLang") ?? "en";
  const defaultRegion = readString(cfg, "region");
  const browserProfile = readString(cfg, "browserProfile");
  const cap = readInt(cfg, "maxResultsCap") ?? 10;
  const closeTabAfterSearch = readBool(cfg, "closeTabAfterSearch") ?? true;
  const closeBrowserAfterSearch = readBool(cfg, "closeBrowserAfterSearch") ?? false;
  const profileArgs = browserProfile ? ["--browser-profile", browserProfile] : [];

  async function evaluate(fn: string): Promise<unknown> {
    return parseTrailingJson(await runBrowser(["evaluate", "--fn", fn, ...profileArgs]));
  }

  // Open the search in a dedicated, reusable labeled tab (becomes the active
  // tab) so we never hijack or leave debris in the user's own tabs.
  async function openSearchTab(url: string): Promise<void> {
    const args = ["open", url, "--label", TAB_LABEL, ...profileArgs];
    try {
      await runBrowser(args);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/not running|no browser|connect|ECONNREFUSED|start/i.test(msg)) {
        await runBrowser(["start", ...profileArgs]);
        await runBrowser(args);
      } else {
        throw err;
      }
    }
  }

  // Google spawns transient session-sync tabs (cookie rotation, the one-Google
  // widget) as separate targets that survive after our search tab closes. Reap
  // them by URL so a search leaves zero debris. Never touches user content.
  async function reapNoiseTabs(): Promise<void> {
    let listing = "";
    try {
      listing = await runBrowser(["tabs", ...profileArgs]);
    } catch {
      return;
    }
    const lines = listing.split("\n");
    const noise = /ogs\.google\.com|accounts\.google\.com\/RotateCookies/i;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/use:\s*(t\d+)/);
      if (!m) continue;
      let url = "";
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const u = lines[j].trim();
        if (/^https?:\/\//.test(u)) {
          url = u;
          break;
        }
      }
      if (noise.test(url)) {
        await runBrowser(["close", m[1], ...profileArgs]).catch(() => {});
      }
    }
  }

  async function cleanup(): Promise<void> {
    if (closeTabAfterSearch || closeBrowserAfterSearch) {
      await runBrowser(["close", TAB_LABEL, ...profileArgs]).catch(() => {});
      await reapNoiseTabs();
    }
    if (closeBrowserAfterSearch) {
      await runBrowser(["stop", ...profileArgs]).catch(() => {});
    }
  }

  return {
    name: TOOL_NAME,
    label: "Google Search",
    description:
      "Search Google in the local browser (real session, logged-in cookies) and return the top organic results as structured JSON. Most human-like path; best for fresh/factual lookups. Result titles/snippets are wrapped as untrusted web content. Use a fetch/page-reading tool to open a result URL.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "The Google search query." },
        num: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Number of results to return (1-20, default 10).",
        },
        hl: {
          type: "string",
          description: 'Interface language override, e.g. "en" or "zh-CN". Defaults to plugin config or "en".',
        },
        gl: { type: "string", description: 'Region override, e.g. "us" or "cn". Optional.' },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readString(rawParams, "query");
      if (!query) throw new Error("google_search requires a non-empty 'query'.");
      const requested = Math.min(Math.max(readInt(rawParams, "num") ?? 10, 1), 20);
      const limit = Math.min(requested, cap);
      const hl = readString(rawParams, "hl") ?? defaultLang;
      const gl = readString(rawParams, "gl") ?? defaultRegion;
      const fetchCount = Math.min(limit + 5, 20); // over-fetch a little for dedup headroom
      const start = Date.now();

      try {
        await openSearchTab(buildSearchUrl(query, fetchCount, hl, gl));

        let raw = (await evaluate(EXTRACT_FN)) as RawResult[];
        if (!Array.isArray(raw) || raw.length === 0) {
          // Re-focus our tab (in case the active tab was stolen) and retry once.
          await runBrowser(["focus", TAB_LABEL, ...profileArgs]).catch(() => {});
          await delay(900);
          raw = (await evaluate(EXTRACT_FN)) as RawResult[];
        }

        if (!Array.isArray(raw) || raw.length === 0) {
          const status = (await evaluate(STATUS_FN)) as {
            captcha?: boolean;
            consent?: boolean;
            url?: string;
            title?: string;
          };
          const note = status?.captcha
            ? "Google is showing a CAPTCHA / 'unusual traffic' page. Open the browser and solve it once; the logged-in session will then work."
            : status?.consent
              ? "Google is showing a consent wall. Open the browser and accept once."
              : "No organic results extracted. Google's result layout may have changed, or the page did not load.";
          return jsonResult({
            query,
            provider: PROVIDER,
            count: 0,
            tookMs: Date.now() - start,
            results: [],
            note,
            page: status,
          });
        }

        const results = raw.slice(0, limit).map((r) => ({
          title: wrapWebContent(r.title, WEB_SOURCE),
          url: r.url,
          snippet: r.snippet ? wrapWebContent(r.snippet, WEB_SOURCE) : "",
        }));

        return jsonResult({
          query,
          provider: PROVIDER,
          count: results.length,
          tookMs: Date.now() - start,
          externalContent: { untrusted: true, source: WEB_SOURCE, provider: PROVIDER, wrapped: true },
          results,
        });
      } finally {
        await cleanup();
      }
    },
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Google Search",
  description: "Local Google search through the real browser; returns compact structured results.",
  register(api: any) {
    api.registerTool((_ctx: unknown) => createGoogleSearchTool(api), { name: TOOL_NAME });
  },
});
