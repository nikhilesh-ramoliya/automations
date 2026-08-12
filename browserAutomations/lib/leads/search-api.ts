/**
 * Official web search APIs for lead company/people lookup.
 * Prefer Brave / Bing HTTP APIs over browser HTML SERP (CAPTCHA-prone).
 *
 * Never log API keys or full Authorization headers.
 */

import { envBool, skipWebSearch } from "./env.js";

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export type SearchApiProvider = "brave" | "bing";

export type LeadSearchProviderMode =
  | "auto"
  | "brave"
  | "bing"
  | "html"
  | "off";

export type SearchWebResult = {
  hits: SearchHit[];
  provider: SearchApiProvider | "none";
  query: string;
  skipped?: boolean;
  reason?: string;
  /** HTTP status when the request failed (never includes secrets). */
  status?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_COUNT = 8;

function trimKey(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

/** Brave Search API key (never log). */
export function braveSearchApiKey(): string | undefined {
  return trimKey("BRAVE_SEARCH_API_KEY");
}

/** Bing Web Search / Azure Cognitive Search key (never log). */
export function bingSearchApiKey(): string | undefined {
  return (
    trimKey("BING_SEARCH_API_KEY") || trimKey("AZURE_BING_SEARCH_KEY")
  );
}

export function hasSearchApiKey(): boolean {
  return Boolean(braveSearchApiKey() || bingSearchApiKey());
}

/**
 * HTML Bing/DDG SERP — explicit opt-in only.
 * Default false (including when API keys are set). Set LEAD_HTML_SEARCH=true
 * to allow browser scraping as last resort after APIs fail.
 */
export function htmlSearchEnabled(): boolean {
  return envBool("LEAD_HTML_SEARCH", false);
}

export function leadSearchProviderMode(): LeadSearchProviderMode {
  const raw = (process.env.LEAD_SEARCH_PROVIDER || "auto")
    .trim()
    .toLowerCase();
  if (
    raw === "auto" ||
    raw === "brave" ||
    raw === "bing" ||
    raw === "html" ||
    raw === "off"
  ) {
    return raw;
  }
  console.warn(
    `  [search-api] Unknown LEAD_SEARCH_PROVIDER=${JSON.stringify(raw)} — using auto`,
  );
  return "auto";
}

/**
 * Ordered API providers to try (Brave before Bing in auto mode).
 * Empty when skip / off / html-only / no matching key.
 */
export function resolveApiProviders(): SearchApiProvider[] {
  if (skipWebSearch()) return [];
  const mode = leadSearchProviderMode();
  if (mode === "off" || mode === "html") return [];

  if (mode === "brave") {
    if (!braveSearchApiKey()) {
      console.warn(
        "  [search-api] LEAD_SEARCH_PROVIDER=brave but BRAVE_SEARCH_API_KEY is unset",
      );
      return [];
    }
    return ["brave"];
  }
  if (mode === "bing") {
    if (!bingSearchApiKey()) {
      console.warn(
        "  [search-api] LEAD_SEARCH_PROVIDER=bing but BING_SEARCH_API_KEY / AZURE_BING_SEARCH_KEY is unset",
      );
      return [];
    }
    return ["bing"];
  }

  // auto: Brave first, then Bing
  const out: SearchApiProvider[] = [];
  if (braveSearchApiKey()) out.push("brave");
  if (bingSearchApiKey()) out.push("bing");
  return out;
}

/**
 * Whether browser HTML SERP may run (last resort).
 * provider=html forces HTML; otherwise requires LEAD_HTML_SEARCH=true.
 */
export function shouldAttemptHtmlSearch(): boolean {
  if (skipWebSearch()) return false;
  const mode = leadSearchProviderMode();
  if (mode === "off") return false;
  if (mode === "html") return true;
  return htmlSearchEnabled();
}

/** True if any search path (API key or HTML opt-in) is available. */
export function hasAnySearchPath(): boolean {
  if (skipWebSearch()) return false;
  if (leadSearchProviderMode() === "off") return false;
  return resolveApiProviders().length > 0 || shouldAttemptHtmlSearch();
}

function redactUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("subscription-key");
    // Drop any param that looks like a secret
    for (const key of [...u.searchParams.keys()]) {
      if (/key|token|secret|auth/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return "[invalid-url]";
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json?: unknown; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
      signal: ctrl.signal,
    });
    const status = res.status;
    if (!res.ok) {
      // Do not log response bodies (may echo query); status is enough.
      console.warn(
        `  [search-api] HTTP ${status} from ${redactUrlForLog(url).split("?")[0] ?? "api"}`,
      );
      return { ok: false, status, error: `http_${status}` };
    }
    const json = (await res.json()) as unknown;
    return { ok: true, status, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = /abort/i.test(msg);
    console.warn(
      `  [search-api] Request failed (${aborted ? "timeout" : "network"}): ${aborted ? "timeout" : "error"}`,
    );
    return {
      ok: false,
      status: 0,
      error: aborted ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

async function searchBrave(
  query: string,
  count: number,
  timeoutMs: number,
): Promise<SearchWebResult> {
  const key = braveSearchApiKey();
  if (!key) {
    return {
      hits: [],
      provider: "none",
      query,
      skipped: true,
      reason: "missing_brave_key",
    };
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, Math.max(1, count))));

  const res = await fetchJson(
    url.toString(),
    { "X-Subscription-Token": key },
    timeoutMs,
  );
  if (!res.ok) {
    return {
      hits: [],
      provider: "brave",
      query,
      skipped: true,
      reason: res.error ?? "brave_error",
      status: res.status,
    };
  }

  const root = asRecord(res.json);
  const web = asRecord(root?.web);
  const results = Array.isArray(web?.results) ? web!.results : [];
  const hits: SearchHit[] = [];
  for (const item of results) {
    const row = asRecord(item);
    if (!row) continue;
    const link = typeof row.url === "string" ? row.url : "";
    if (!/^https?:\/\//i.test(link)) continue;
    hits.push({
      title: typeof row.title === "string" ? row.title : "",
      url: link,
      snippet:
        typeof row.description === "string"
          ? row.description
          : typeof row.extra_snippets === "object" &&
              Array.isArray(row.extra_snippets)
            ? String(row.extra_snippets[0] ?? "")
            : "",
    });
  }

  return { hits, provider: "brave", query };
}

async function searchBingApi(
  query: string,
  count: number,
  timeoutMs: number,
): Promise<SearchWebResult> {
  const key = bingSearchApiKey();
  if (!key) {
    return {
      hits: [],
      provider: "none",
      query,
      skipped: true,
      reason: "missing_bing_key",
    };
  }

  const url = new URL("https://api.bing.microsoft.com/v7.0/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(50, Math.max(1, count))));
  url.searchParams.set("responseFilter", "Webpages");
  url.searchParams.set("textDecorations", "false");
  url.searchParams.set("textFormat", "Raw");

  const res = await fetchJson(
    url.toString(),
    { "Ocp-Apim-Subscription-Key": key },
    timeoutMs,
  );
  if (!res.ok) {
    return {
      hits: [],
      provider: "bing",
      query,
      skipped: true,
      reason: res.error ?? "bing_error",
      status: res.status,
    };
  }

  const root = asRecord(res.json);
  const webPages = asRecord(root?.webPages);
  const values = Array.isArray(webPages?.value) ? webPages!.value : [];
  const hits: SearchHit[] = [];
  for (const item of values) {
    const row = asRecord(item);
    if (!row) continue;
    const link = typeof row.url === "string" ? row.url : "";
    if (!/^https?:\/\//i.test(link)) continue;
    hits.push({
      title: typeof row.name === "string" ? row.name : "",
      url: link,
      snippet: typeof row.snippet === "string" ? row.snippet : "",
    });
  }

  return { hits, provider: "bing", query };
}

/**
 * Run one web search against an official API (Brave or Bing).
 * Does **not** consume LEAD_MAX_WEB_SEARCHES — callers must call
 * `tryConsumeWebSearch()` before invoking this.
 */
export async function searchWeb(
  query: string,
  opts?: {
    count?: number;
    provider?: SearchApiProvider;
    timeoutMs?: number;
  },
): Promise<SearchWebResult> {
  const q = query.trim();
  if (!q) {
    return {
      hits: [],
      provider: "none",
      query: q,
      skipped: true,
      reason: "empty_query",
    };
  }
  if (skipWebSearch()) {
    return {
      hits: [],
      provider: "none",
      query: q,
      skipped: true,
      reason: "LEAD_SKIP_WEB_SEARCH",
    };
  }

  const count = opts?.count ?? DEFAULT_COUNT;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const providers: SearchApiProvider[] = opts?.provider
    ? [opts.provider]
    : resolveApiProviders();

  if (providers.length === 0) {
    return {
      hits: [],
      provider: "none",
      query: q,
      skipped: true,
      reason: hasSearchApiKey()
        ? "provider_unavailable"
        : "no_search_api_key",
    };
  }

  let last: SearchWebResult | undefined;
  for (const provider of providers) {
    const result =
      provider === "brave"
        ? await searchBrave(q, count, timeoutMs)
        : await searchBingApi(q, count, timeoutMs);
    last = result;
    if (!result.skipped && result.hits.length > 0) {
      console.log(
        `  [search-api] ${provider}: ${result.hits.length} hit(s) for query (${q.length} chars)`,
      );
      return result;
    }
    if (result.skipped) {
      console.warn(
        `  [search-api] ${provider} skipped: ${result.reason ?? "unknown"}`,
      );
    } else {
      console.log(`  [search-api] ${provider}: 0 hits`);
    }
    // Try next provider on empty / error (auto waterfall)
    if (opts?.provider) break;
  }

  return (
    last ?? {
      hits: [],
      provider: "none",
      query: q,
      skipped: true,
      reason: "no_search_api_key",
    }
  );
}

/** Map API provider id to WebsiteSearchResult.engine label. */
export function apiProviderToEngineLabel(
  provider: SearchApiProvider | "none",
): "brave" | "bing_api" | "none" {
  if (provider === "brave") return "brave";
  if (provider === "bing") return "bing_api";
  return "none";
}
