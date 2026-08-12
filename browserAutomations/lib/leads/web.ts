import type { Page } from "playwright";
import { humanDelay, sampleHumanDelayMs, type HumanDelayOp } from "../linkedin-safety.js";
import { envInt, skipWebSearch, webDelayMult } from "./env.js";
import {
  apiProviderToEngineLabel,
  hasAnySearchPath,
  resolveApiProviders,
  searchWeb,
  shouldAttemptHtmlSearch,
  type SearchApiProvider,
} from "./search-api.js";

const TECH_TERMS = [
  "react",
  "angular",
  "vue",
  "node",
  "python",
  "java",
  ".net",
  "aws",
  "azure",
  "gcp",
  "kubernetes",
  "docker",
  "salesforce",
  "sap",
  "oracle",
  "shopify",
  "wordpress",
  "hubspot",
  "zendesk",
  "servicenow",
  "terraform",
  "ci/cd",
  "microservices",
  "legacy",
  "erp",
  "crm",
];

const BUYING_HINTS = [
  "we're hiring",
  "we are hiring",
  "join our team",
  "open roles",
  "careers",
  "digital transformation",
  "modernization",
  "cloud migration",
  "request a demo",
  "partner with",
  "technology partner",
];

const SERVICE_HINTS = [
  "services",
  "solutions",
  "products",
  "platform",
  "consulting",
  "software",
  "automation",
  "cloud",
  "devops",
  "integration",
  "managed services",
];

export type WebPageExtract = {
  url: string;
  ok: boolean;
  status?: number;
  pageTitle?: string;
  metaDescription?: string;
  aboutBlurb?: string;
  techKeywords: string[];
  buyingHints: string[];
  servicesHints: string[];
  locationHints: string[];
  careersUrl?: string;
  contactUrl?: string;
  blogUrl?: string;
  engineeringUrl?: string;
  snippet?: string;
  error?: string;
};

export type SearchEngine = "bing" | "duckduckgo" | "google";

/** HTML SERP engine or official API source label. */
export type WebsiteSearchSource =
  | SearchEngine
  | "brave"
  | "bing_api"
  | "none";

export type WebsiteSearchResult = {
  websiteUrl?: string;
  searchUrl: string;
  engine: WebsiteSearchSource;
  query?: string;
  candidates: string[];
  queriesTried?: string[];
  skipped?: boolean;
  reason?: string;
};

/** Mutable per-run web-search budget (shared across enrich helpers). */
let webSearchesUsed = 0;
/** Serialize budget checks under parallel web workers. */
let webSearchBudgetChain: Promise<unknown> = Promise.resolve();
/** Serialize all SERP navigations — never parallelize search engines. */
let webSearchSerialChain: Promise<unknown> = Promise.resolve();
/** Engines that hit a CAPTCHA/challenge this run (do not retry in a loop). */
const blockedEngines = new Set<SearchEngine>();
/** Soft stop: further searches skipped after challenge + one alternate attempt. */
let webSearchSoftStop = false;

export function resetWebSearchBudget(): void {
  webSearchesUsed = 0;
  webSearchBudgetChain = Promise.resolve();
  webSearchSerialChain = Promise.resolve();
  blockedEngines.clear();
  webSearchSoftStop = false;
}

export function getMaxWebSearches(): number {
  return envInt("LEAD_MAX_WEB_SEARCHES", 10);
}

export function remainingWebSearches(): number {
  if (skipWebSearch() || webSearchSoftStop) return 0;
  return Math.max(0, getMaxWebSearches() - webSearchesUsed);
}

/** Atomically consume one web-search slot (safe under parallel mapPool). */
export async function tryConsumeWebSearch(): Promise<boolean> {
  if (skipWebSearch() || webSearchSoftStop) return false;
  let ok = false;
  const prev = webSearchBudgetChain;
  webSearchBudgetChain = prev.then(() => {
    if (webSearchesUsed < getMaxWebSearches()) {
      webSearchesUsed += 1;
      ok = true;
    }
  });
  await webSearchBudgetChain;
  return ok;
}

/** Run SERP work strictly one-at-a-time across the whole process. */
export async function withWebSearchLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = webSearchSerialChain;
  let release!: () => void;
  webSearchSerialChain = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function isSearchEngineBlocked(engine: SearchEngine): boolean {
  return blockedEngines.has(engine);
}

export function markSearchEngineBlocked(engine: SearchEngine): void {
  blockedEngines.add(engine);
}

export function isWebSearchSoftStopped(): boolean {
  return webSearchSoftStop || skipWebSearch();
}

/** Stop further SERP queries for this run (after CAPTCHA cool-down path). */
export function softStopWebSearch(reason?: string): void {
  webSearchSoftStop = true;
  if (reason) {
    console.warn(`  [web-search] Soft-stop: ${reason}`);
  }
}

/**
 * After a challenge: ban that engine. Soft-stop when no alternate remains.
 */
export function noteSearchChallenge(
  engine: SearchEngine,
  preferred: SearchEngine[] = ["bing", "duckduckgo"],
): void {
  markSearchEngineBlocked(engine);
  const remaining = preferred.filter((e) => !blockedEngines.has(e));
  if (remaining.length === 0) {
    softStopWebSearch(`all engines challenged (last=${engine})`);
  }
}

const SEARCH_CHALLENGE_RE =
  /unusual traffic|please solve|confirm you(?:'| a)?re a human|are you a robot|select all (?:images|squares)|recaptcha|hcaptcha|cf-challenge|challenge-platform|attention required|verify you are human|bot detection|captcha|sorry,? we (?:couldn.?t|cannot) verify|automated queries/i;

/** Detect Bing/DDG/Google/Cloudflare CAPTCHA or bot-challenge pages. */
export function looksLikeSearchChallenge(opts: {
  url?: string;
  title?: string;
  bodyText?: string;
}): boolean {
  const url = (opts.url ?? "").toLowerCase();
  const title = (opts.title ?? "").toLowerCase();
  const body = (opts.bodyText ?? "").slice(0, 2500);
  if (
    /\/challenge|captcha|cf-browser-verification|cdn-cgi\/challenge|sorry\/index|interstitial/i.test(
      url,
    )
  ) {
    return true;
  }
  if (SEARCH_CHALLENGE_RE.test(title) || SEARCH_CHALLENGE_RE.test(body)) {
    return true;
  }
  // Bing often shows a thin interstitial with little SERP chrome
  if (
    /bing\.com/i.test(url) &&
    /verification|human|robot/i.test(body) &&
    !/#b_results|b_algo/i.test(body)
  ) {
    return true;
  }
  return false;
}

export async function detectSearchChallenge(page: Page): Promise<{
  challenged: boolean;
  url: string;
  title: string;
  snippet: string;
}> {
  const url = page.url();
  const meta = (await page.evaluate(`(() => ({
    title: (document.title || "").trim(),
    body: (document.body && document.body.innerText
      ? document.body.innerText
      : ""
    ).slice(0, 2000),
  }))()`)) as { title: string; body: string };
  const challenged = looksLikeSearchChallenge({
    url,
    title: meta.title,
    bodyText: meta.body,
  });
  return {
    challenged,
    url,
    title: meta.title,
    snippet: meta.body.slice(0, 200),
  };
}

/**
 * Human pause for web/SERP work: LI_SAFE_DELAY_MULT × LEAD_WEB_DELAY_MULT.
 * Prefer longer floors around search navigations.
 */
export async function webPace(
  op: HumanDelayOp = "search",
  opts?: { minMs?: number; maxMs?: number },
): Promise<number> {
  const mult = webDelayMult();
  const base = sampleHumanDelayMs(op, {
    minMs: opts?.minMs,
    maxMs: opts?.maxMs,
  });
  const ms = Math.max(0, Math.round(base * mult));
  if (ms > 0) {
    await new Promise((r) => setTimeout(r, ms));
  }
  return ms;
}

const JUNK_HOST_RE =
  /linkedin\.com|facebook\.com|twitter\.com|x\.com|youtube\.com|instagram\.com|tiktok\.com|google\.|bing\.com|duckduckgo\.com|yahoo\.com|wikipedia\.org|crunchbase\.com|yelp\.com|bloomberg\.com|glassdoor\.com|indeed\.com|zoominfo\.com|apollo\.io|rocketreach\.co|pitchbook\.com|owler\.com|dnb\.com|bbb\.org|mapquest\.com|yellowpages\.com|clutch\.co|goodfirms\.co|g2\.com|capterra\.com|sourceforge\.net|github\.com|medium\.com|reddit\.com|quora\.com|pinterest\.com|amazon\.com|microsoft\.com|apple\.com|play\.google|\.gov(\.|$)|gov\.in|nic\.in/i;

/** Unwrap Bing/DDG/Google redirect wrappers to the destination URL. */
export function unwrapSearchRedirect(href: string): string {
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();

    // Bing click-tracking: /ck/a?...&u=a1<base64>
    if (host.includes("bing.com")) {
      const raw = u.searchParams.get("u");
      if (raw) {
        const b64 = raw.startsWith("a1") ? raw.slice(2) : raw;
        try {
          const decoded = Buffer.from(b64, "base64").toString("utf8");
          if (/^https?:\/\//i.test(decoded)) return decoded;
        } catch {
          /* ignore */
        }
      }
    }

    // DuckDuckGo lite redirect
    if (host.includes("duckduckgo.com")) {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }

    // Google /url?q=
    if (host.includes("google.")) {
      const q = u.searchParams.get("q") || u.searchParams.get("url");
      if (q && /^https?:\/\//i.test(q)) return q;
    }
  } catch {
    /* ignore */
  }
  return href;
}

function normalizeHomepage(href: string): string | undefined {
  try {
    const unwrapped = unwrapSearchRedirect(href);
    const u = new URL(unwrapped);
    if (!/^https?:$/i.test(u.protocol)) return undefined;
    const host = u.hostname.toLowerCase();
    if (JUNK_HOST_RE.test(host)) return undefined;
    if (/\/search\b/i.test(u.pathname) && /[?&]q=/i.test(u.search)) {
      return undefined;
    }
    return `${u.protocol}//${u.host}/`;
  } catch {
    return undefined;
  }
}

function scoreCandidateUrl(href: string, companyName: string): number {
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const tokens = companyName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);
    let score = 0;
    for (const t of tokens) {
      if (host.includes(t)) score += 3;
    }
    const slug = tokens.join("");
    if (slug.length > 4 && host.replace(/[^a-z0-9]/g, "").includes(slug)) {
      score += 4;
    }
    if (
      host.endsWith(".com") ||
      host.endsWith(".io") ||
      host.endsWith(".co") ||
      host.endsWith(".in") ||
      host.endsWith(".net") ||
      host.endsWith(".ai")
    ) {
      score += 1;
    }
    if (u.pathname === "/" || u.pathname === "") score += 1;
    return score;
  } catch {
    return 0;
  }
}

/** Query variants for official-site discovery (budget-friendly order). */
export function officialSiteQueryVariants(
  companyName: string,
  hint?: string,
): string[] {
  const name = companyName.trim();
  const variants = [
    hint?.trim(),
    `"${name}" official site`,
    `"${name}" official website`,
    `"${name}" homepage`,
    `${name} company website -site:linkedin.com -site:facebook.com`,
    `"${name}" (website OR homepage OR "official site")`,
  ].filter((q): q is string => Boolean(q && q.length > 2));
  return [...new Set(variants)];
}

function buildSearchUrl(engine: SearchEngine, q: string): string {
  const enc = encodeURIComponent(q);
  if (engine === "duckduckgo") {
    return `https://html.duckduckgo.com/html/?q=${enc}`;
  }
  if (engine === "google") {
    return `https://www.google.com/search?q=${enc}&hl=en`;
  }
  return `https://www.bing.com/search?q=${enc}`;
}

async function collectResultHrefs(page: Page): Promise<string[]> {
  return (await page.evaluate(`(() => {
    const out = [];
    const sels = [
      "#b_results h2 a[href]",
      "#b_results .b_algo h2 a[href]",
      "#b_results .b_algo a[href]",
      "#b_results cite",
      "li.b_algo a[href]",
      "a.result__a[href]",
      "a[data-testid='result-title-a'][href]",
      "#links .result__a[href]",
      ".results .result__a[href]",
      "a.result-link[href]",
      "#rso a[href]",
      "div.g a[href]",
    ];
    for (const sel of sels) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (el.tagName === "CITE") {
          const t = (el.textContent || "").trim();
          const hostPart = (t.split(/\\s|\\u203a|›/)[0] || "").replace(/\\/+$/, "");
          if (/^https?:\\/\\//i.test(t)) out.push(t);
          else if (/^[\\w.-]+\\.[a-z]{2,}/i.test(hostPart)) {
            out.push("https://" + hostPart);
          }
          continue;
        }
        const href = el.getAttribute("href") || "";
        if (href.startsWith("http") || href.startsWith("/url?")) out.push(href);
        try {
          const u = new URL(href, location.href);
          const uddg = u.searchParams.get("uddg");
          if (uddg) out.push(decodeURIComponent(uddg));
        } catch {}
      }
    }
    if (out.length === 0) {
      for (const a of Array.from(document.querySelectorAll(
        "main a[href], #b_content a[href], #search a[href], body a[href]",
      ))) {
        const href = a.getAttribute("href") || "";
        if (/^https?:\\/\\//i.test(href) || href.startsWith("/url?")) out.push(href);
        try {
          const u = new URL(href, location.href);
          const uddg = u.searchParams.get("uddg");
          if (uddg) out.push(decodeURIComponent(uddg));
        } catch {}
      }
    }
    return out.slice(0, 40);
  })()`)) as string[];
}

function rankCandidates(hrefs: string[], companyName: string): string[] {
  const scored: { url: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    let absolute = href;
    if (href.startsWith("/url?")) {
      absolute = `https://www.google.com${href}`;
    }
    const home = normalizeHomepage(absolute);
    if (!home || seen.has(home)) continue;
    seen.add(home);
    scored.push({ url: home, score: scoreCandidateUrl(home, companyName) });
  }
  scored.sort((a, b) => b.score - a.score);
  // Require meaningful name↔host match (avoids digitalindia.gov for "Digital Trans4orMation")
  return scored.filter((s) => s.score >= 6).map((s) => s.url);
}

function mergeRankedCandidates(
  existing: string[],
  hrefs: string[],
  companyName: string,
): string[] {
  const merged = [...existing];
  for (const h of hrefs) {
    if (!merged.includes(h)) merged.push(h);
  }
  return rankCandidates(merged, companyName);
}

function strongWebsiteHit(
  candidates: string[],
  companyName: string,
): string | undefined {
  const top = candidates[0];
  if (!top) return undefined;
  return scoreCandidateUrl(top, companyName) >= 6 ? top : undefined;
}

/**
 * Official-site discovery via Brave/Bing Search APIs (no browser).
 * Respects LEAD_MAX_WEB_SEARCHES. Does not use HTML SERP.
 */
async function searchOfficialWebsiteViaApi(
  companyName: string,
  opts?: {
    hint?: string;
    providers?: SearchApiProvider[];
    maxQueries?: number;
  },
): Promise<WebsiteSearchResult> {
  const providers = opts?.providers ?? resolveApiProviders();
  if (providers.length === 0) {
    return {
      searchUrl: "",
      engine: "none",
      candidates: [],
      skipped: true,
      reason: "no_search_api_key",
    };
  }
  if (skipWebSearch() || webSearchSoftStop) {
    return {
      searchUrl: "",
      engine: "none",
      candidates: [],
      skipped: true,
      reason: skipWebSearch()
        ? "LEAD_SKIP_WEB_SEARCH"
        : "web_search_soft_stop_captcha",
    };
  }

  const variants = officialSiteQueryVariants(companyName, opts?.hint);
  const maxQueries =
    opts?.maxQueries ?? Math.min(variants.length * providers.length, 4);
  const queriesTried: string[] = [];
  let allCandidates: string[] = [];
  let lastProvider: SearchApiProvider | "none" = "none";
  let lastQuery: string | undefined;
  let lastReason: string | undefined;
  let attempts = 0;
  let anyApiOk = false;

  for (const q of variants) {
    if (attempts >= maxQueries) break;
    if (strongWebsiteHit(allCandidates, companyName)) break;
    if (remainingWebSearches() <= 0) break;

    for (const provider of providers) {
      if (attempts >= maxQueries) break;
      if (remainingWebSearches() <= 0) break;
      if (webSearchSoftStop) break;

      if (!(await tryConsumeWebSearch())) {
        lastReason = `LEAD_MAX_WEB_SEARCHES (${getMaxWebSearches()}) reached`;
        break;
      }

      attempts += 1;
      queriesTried.push(`${provider}_api:${q}`);
      lastQuery = q;
      lastProvider = provider;

      const api = await searchWeb(q, { count: 10, provider });
      if (api.skipped && api.hits.length === 0) {
        lastReason = api.reason ?? `${provider}_error`;
        continue;
      }
      anyApiOk = true;
      allCandidates = mergeRankedCandidates(
        allCandidates,
        api.hits.map((h) => h.url),
        companyName,
      );
      const hit = strongWebsiteHit(allCandidates, companyName);
      if (hit) {
        return {
          websiteUrl: hit,
          searchUrl: `api://${provider}`,
          engine: apiProviderToEngineLabel(provider),
          query: q,
          candidates: allCandidates.slice(0, 5),
          queriesTried,
        };
      }
    }
  }

  const top = allCandidates[0];
  return {
    websiteUrl: top,
    searchUrl: lastProvider !== "none" ? `api://${lastProvider}` : "",
    engine: apiProviderToEngineLabel(lastProvider),
    query: lastQuery,
    candidates: allCandidates.slice(0, 5),
    queriesTried,
    skipped: !allCandidates.length,
    reason: allCandidates.length
      ? undefined
      : lastReason ??
        (anyApiOk ? "api_no_result" : "api_unavailable"),
  };
}

/**
 * Single HTML SERP search against one engine/query — capped by LEAD_MAX_WEB_SEARCHES.
 * Always serialized; detects CAPTCHA and bans that engine (no retry loop).
 * Prefer API path via searchOfficialWebsiteMulti unless LEAD_HTML_SEARCH=true.
 */
export async function searchOfficialWebsite(
  page: Page,
  companyName: string,
  opts?: { hint?: string; engine?: SearchEngine; query?: string },
): Promise<WebsiteSearchResult> {
  const engine = opts?.engine ?? "bing";

  if (skipWebSearch()) {
    return {
      searchUrl: "",
      engine,
      candidates: [],
      skipped: true,
      reason: "LEAD_SKIP_WEB_SEARCH",
    };
  }
  if (!shouldAttemptHtmlSearch()) {
    return {
      searchUrl: "",
      engine,
      candidates: [],
      skipped: true,
      reason: "LEAD_HTML_SEARCH_disabled",
    };
  }
  if (webSearchSoftStop) {
    return {
      searchUrl: "",
      engine,
      candidates: [],
      skipped: true,
      reason: "web_search_soft_stop_captcha",
    };
  }
  if (isSearchEngineBlocked(engine)) {
    return {
      searchUrl: "",
      engine,
      candidates: [],
      skipped: true,
      reason: `engine_blocked:${engine}`,
    };
  }
  if (remainingWebSearches() <= 0) {
    return {
      searchUrl: "",
      engine,
      candidates: [],
      skipped: true,
      reason: `LEAD_MAX_WEB_SEARCHES (${getMaxWebSearches()}) reached`,
    };
  }

  const q =
    opts?.query?.trim() ||
    opts?.hint?.trim() ||
    `"${companyName}" official site`;
  const searchUrl = buildSearchUrl(engine, q);

  return withWebSearchLock(async () => {
    if (isSearchEngineBlocked(engine) || webSearchSoftStop) {
      return {
        searchUrl: "",
        engine,
        candidates: [],
        skipped: true,
        reason: isSearchEngineBlocked(engine)
          ? `engine_blocked:${engine}`
          : "web_search_soft_stop_captcha",
      };
    }
    if (!(await tryConsumeWebSearch())) {
      return {
        searchUrl: "",
        engine,
        candidates: [],
        skipped: true,
        reason: `LEAD_MAX_WEB_SEARCHES (${getMaxWebSearches()}) reached`,
      };
    }

    await webPace("search", { minMs: 2500 });
    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await webPace("search", { minMs: 2000 });
    } catch {
      return {
        searchUrl,
        engine,
        query: q,
        candidates: [],
        reason: "navigation_failed",
      };
    }

    const challenge = await detectSearchChallenge(page);
    if (challenge.challenged) {
      noteSearchChallenge(engine);
      console.warn(
        `  [web-search] CAPTCHA/challenge on ${engine} — engine banned for this run` +
          (webSearchSoftStop ? " (soft-stop: no more SERP queries)" : ""),
      );
      return {
        searchUrl,
        engine,
        query: q,
        candidates: [],
        skipped: true,
        reason: `serp_challenge:${engine}`,
      };
    }

    const hrefs = await collectResultHrefs(page);
    const candidates = rankCandidates(hrefs, companyName);

    return {
      websiteUrl: candidates[0],
      searchUrl,
      engine,
      query: q,
      candidates: candidates.slice(0, 5),
    };
  });
}

/**
 * HTML Bing/DDG multi-query official-site search (last resort).
 * On CAPTCHA: ban that engine and try one alternate once — never loop.
 */
async function searchOfficialWebsiteMultiHtml(
  page: Page,
  companyName: string,
  opts?: {
    hint?: string;
    engines?: SearchEngine[];
    maxQueries?: number;
  },
): Promise<WebsiteSearchResult> {
  const engines = opts?.engines ?? ["bing", "duckduckgo"];
  const variants = officialSiteQueryVariants(companyName, opts?.hint);
  const maxQueries =
    opts?.maxQueries ?? Math.min(variants.length * engines.length, 4);
  const queriesTried: string[] = [];
  let last: WebsiteSearchResult | undefined;
  let allCandidates: string[] = [];
  let alternateAfterChallengeUsed = false;

  let attempts = 0;
  for (const q of variants) {
    for (const engine of engines) {
      if (attempts >= maxQueries) break;
      if (webSearchSoftStop) break;
      if (isSearchEngineBlocked(engine)) continue;
      if (remainingWebSearches() <= 0) {
        return {
          searchUrl: last?.searchUrl ?? "",
          engine: last?.engine ?? engines[0]!,
          query: last?.query,
          candidates: allCandidates.slice(0, 5),
          websiteUrl: allCandidates[0],
          queriesTried,
          skipped: !allCandidates.length,
          reason: allCandidates.length
            ? undefined
            : `LEAD_MAX_WEB_SEARCHES (${getMaxWebSearches()}) reached`,
        };
      }
      attempts += 1;
      queriesTried.push(`${engine}:${q}`);
      const result = await searchOfficialWebsite(page, companyName, {
        engine,
        query: q,
      });
      last = result;

      if (result.reason?.startsWith("serp_challenge:")) {
        if (!alternateAfterChallengeUsed) {
          alternateAfterChallengeUsed = true;
          const alt = engines.find(
            (e) => e !== engine && !isSearchEngineBlocked(e),
          );
          if (alt && remainingWebSearches() > 0 && attempts < maxQueries) {
            attempts += 1;
            queriesTried.push(`${alt}:${q}:alt`);
            const altResult = await searchOfficialWebsite(page, companyName, {
              engine: alt,
              query: q,
            });
            last = altResult;
            allCandidates = mergeRankedCandidates(
              allCandidates,
              altResult.candidates,
              companyName,
            );
            softStopWebSearch(
              altResult.reason?.startsWith("serp_challenge:")
                ? "CAPTCHA on primary + alternate — skipping further SERP"
                : "CAPTCHA on primary; one alternate tried — skipping further SERP",
            );
            return {
              websiteUrl: allCandidates[0],
              searchUrl: altResult.searchUrl,
              engine: alt,
              query: q,
              candidates: allCandidates.slice(0, 5),
              queriesTried,
              skipped: !allCandidates.length,
              reason: altResult.reason?.startsWith("serp_challenge:")
                ? "serp_challenge_all_engines"
                : allCandidates.length
                  ? undefined
                  : altResult.reason ?? "web_search_no_result",
            };
          }
        }
        softStopWebSearch(
          `CAPTCHA on ${engine}; no alternate available — skipping further SERP`,
        );
        return {
          websiteUrl: allCandidates[0],
          searchUrl: result.searchUrl,
          engine,
          query: q,
          candidates: allCandidates.slice(0, 5),
          queriesTried,
          skipped: !allCandidates.length,
          reason: "serp_challenge",
        };
      }

      allCandidates = mergeRankedCandidates(
        allCandidates,
        result.candidates,
        companyName,
      );
      if (strongWebsiteHit(allCandidates, companyName)) {
        return {
          websiteUrl: allCandidates[0],
          searchUrl: result.searchUrl,
          engine,
          query: q,
          candidates: allCandidates.slice(0, 5),
          queriesTried,
        };
      }
      await webPace("idle_micro", { minMs: 800 });
    }
    if (attempts >= maxQueries || webSearchSoftStop) break;
  }

  return {
    websiteUrl: allCandidates[0],
    searchUrl: last?.searchUrl ?? "",
    engine: last?.engine ?? engines[0]!,
    query: last?.query,
    candidates: allCandidates.slice(0, 5),
    queriesTried,
    skipped: !allCandidates.length && (last?.skipped ?? false),
    reason: allCandidates.length
      ? undefined
      : last?.reason ?? "web_search_no_result",
  };
}

/**
 * Discover official website: Brave/Bing API first, HTML SERP only if
 * LEAD_HTML_SEARCH=true and no API result. Soft-fails clearly — never CAPTCHA loop.
 * `page` is required only for the HTML fallback path.
 */
export async function searchOfficialWebsiteMulti(
  page: Page | null,
  companyName: string,
  opts?: {
    hint?: string;
    engines?: SearchEngine[];
    maxQueries?: number;
  },
): Promise<WebsiteSearchResult> {
  if (skipWebSearch()) {
    return {
      searchUrl: "",
      engine: "none",
      candidates: [],
      skipped: true,
      reason: "LEAD_SKIP_WEB_SEARCH",
    };
  }

  if (!hasAnySearchPath()) {
    console.warn(
      "  [web-search] No search path: set BRAVE_SEARCH_API_KEY or BING_SEARCH_API_KEY," +
        " or LEAD_HTML_SEARCH=true (CAPTCHA risk). Relying on known website / LinkedIn About.",
    );
    return {
      searchUrl: "",
      engine: "none",
      candidates: [],
      skipped: true,
      reason: "no_search_provider",
    };
  }

  const providers = resolveApiProviders();
  let apiResult: WebsiteSearchResult | undefined;

  if (providers.length > 0) {
    apiResult = await searchOfficialWebsiteViaApi(companyName, {
      hint: opts?.hint,
      providers,
      maxQueries: opts?.maxQueries,
    });
    if (strongWebsiteHit(apiResult.candidates, companyName)) {
      return apiResult;
    }
    // Weak candidates still useful if HTML is off
    if (apiResult.websiteUrl && !shouldAttemptHtmlSearch()) {
      return apiResult;
    }
  }

  // HTML last resort — only when opted in AND no strong API website hit
  if (
    shouldAttemptHtmlSearch() &&
    page &&
    !strongWebsiteHit(apiResult?.candidates ?? [], companyName)
  ) {
    console.log(
      "  [web-search] Falling back to HTML SERP (LEAD_HTML_SEARCH=true)",
    );
    const html = await searchOfficialWebsiteMultiHtml(page, companyName, {
      hint: opts?.hint,
      engines: opts?.engines,
      maxQueries: opts?.maxQueries,
    });
    if (apiResult?.queriesTried?.length) {
      html.queriesTried = [
        ...(apiResult.queriesTried ?? []),
        ...(html.queriesTried ?? []),
      ];
    }
    // Prefer HTML hit; otherwise keep weak API candidates if any
    if (html.websiteUrl || !apiResult?.websiteUrl) {
      return html;
    }
    return {
      ...apiResult,
      queriesTried: html.queriesTried,
    };
  }

  if (apiResult) return apiResult;

  return {
    searchUrl: "",
    engine: "none",
    candidates: [],
    skipped: true,
    reason: shouldAttemptHtmlSearch()
      ? "html_unavailable_no_page"
      : "no_search_provider",
  };
}

export async function extractWebPage(
  page: Page,
  url: string,
  timeoutMs = 25_000,
  opts?: { settle?: HumanDelayOp },
): Promise<WebPageExtract> {
  try {
    const res = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await humanDelay(opts?.settle ?? "read_website");
    const status = res?.status();
    const data = (await page.evaluate(`(() => {
      const title = (document.title || "").trim();
      const meta =
        document.querySelector('meta[name="description"]')?.getAttribute("content") ||
        document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
        "";
      const body = (document.body && document.body.innerText
        ? document.body.innerText
        : ""
      ).replace(/\\s+/g, " ").slice(0, 12000);

      let about = "";
      const aboutEl =
        document.querySelector("#about, [id*='about'], section.about, .about-us") ||
        null;
      if (aboutEl) {
        about = (aboutEl.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 800);
      }
      if (!about) {
        const paras = Array.from(document.querySelectorAll("p"))
          .map((p) => (p.textContent || "").replace(/\\s+/g, " ").trim())
          .filter((t) => t.length > 80 && t.length < 600);
        about = (paras[0] || "").slice(0, 800);
      }

      let careers = "";
      let contact = "";
      let blog = "";
      let engineering = "";
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") || "";
        const t = (a.textContent || "").toLowerCase();
        const blob = href + " " + t;
        const abs = (() => {
          try { return new URL(href, location.href).href; } catch { return ""; }
        })();
        if (!abs) continue;
        if (!careers && /career|job|hiring|join.?us/i.test(blob)) careers = abs;
        if (!contact && /contact|get.?in.?touch|support@|sales@/i.test(blob)) contact = abs;
        if (!blog && /\\b(blog|news|insights|articles)\\b/i.test(blob)) blog = abs;
        if (!engineering && /engineering|tech.?blog|developers|careers\\/engineering/i.test(blob)) {
          engineering = abs;
        }
      }

      const locHints = [];
      const locMatch = body.match(
        /(?:headquarters|based in|located in|offices? in)\\s*[:\\-]?\\s*([A-Z][A-Za-z0-9 ,.-]{3,60})/i,
      );
      if (locMatch && locMatch[1]) locHints.push(locMatch[1].trim());

      return {
        title,
        meta: (meta || "").trim(),
        body,
        about,
        careers,
        contact,
        blog,
        engineering,
        locHints,
      };
    })()`)) as {
      title: string;
      meta: string;
      body: string;
      about: string;
      careers: string;
      contact: string;
      blog: string;
      engineering: string;
      locHints: string[];
    };

    const blob = `${data.title} ${data.meta} ${data.body}`.toLowerCase();
    const techKeywords = TECH_TERMS.filter((t) => blob.includes(t));
    const buyingHints = BUYING_HINTS.filter((t) => blob.includes(t));
    const servicesHints = SERVICE_HINTS.filter((t) => blob.includes(t));

    return {
      url,
      ok: status !== undefined && status >= 200 && status < 400,
      status,
      pageTitle: data.title || undefined,
      metaDescription: data.meta || undefined,
      aboutBlurb: data.about || data.meta || undefined,
      techKeywords,
      buyingHints,
      servicesHints,
      locationHints: data.locHints ?? [],
      careersUrl: data.careers || undefined,
      contactUrl: data.contact || undefined,
      blogUrl: data.blog || undefined,
      engineeringUrl: data.engineering || undefined,
      snippet: data.body.slice(0, 280) || undefined,
    };
  } catch (err) {
    return {
      url,
      ok: false,
      techKeywords: [],
      buyingHints: [],
      servicesHints: [],
      locationHints: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function guessCareersUrl(websiteUrl: string): string[] {
  try {
    const u = new URL(websiteUrl);
    const base = `${u.protocol}//${u.host}`;
    return [
      `${base}/careers`,
      `${base}/jobs`,
      `${base}/career`,
      `${base}/about/careers`,
    ];
  } catch {
    return [];
  }
}

/** Extra pages useful for tech/buying signals (blog, engineering, about). */
export function guessSignalUrls(
  websiteUrl: string,
  extracted?: Partial<WebPageExtract>,
): string[] {
  const urls: string[] = [];
  if (extracted?.careersUrl) urls.push(extracted.careersUrl);
  if (extracted?.blogUrl) urls.push(extracted.blogUrl);
  if (extracted?.engineeringUrl) urls.push(extracted.engineeringUrl);
  try {
    const u = new URL(websiteUrl);
    const base = `${u.protocol}//${u.host}`;
    urls.push(
      `${base}/blog`,
      `${base}/engineering`,
      `${base}/about`,
      `${base}/technology`,
    );
  } catch {
    /* ignore */
  }
  return [...new Set(urls)];
}

/** Paths that should not be crawled for tech signals. */
const TECH_CRAWL_SKIP_RE =
  /logout|sign[\s_-]?out|cart|checkout|basket|login|sign[\s_-]?in|signin|register|sign[\s_-]?up|password|forgot|wp-admin|account\/|my-account|wishlist|cdn\.|\.pdf($|\?)|\.zip($|\?)|\.docx?($|\?)/i;

const TECH_CRAWL_SOCIAL_HOST_RE =
  /facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|pinterest\.com|threads\.net/i;

/** Link text/path keywords → priority for tech/buying signal pages. */
const TECH_CRAWL_LINK_SCORES: { re: RegExp; score: number }[] = [
  { re: /\b(careers?|jobs?|hiring|join[\s_-]?us|open[\s_-]?roles?)\b/i, score: 100 },
  { re: /\b(engineering|tech[\s_-]?blog|developers?|technology|tech)\b/i, score: 90 },
  { re: /\b(stack|platform|software|cloud|erp|saas|it)\b/i, score: 82 },
  {
    re: /\b(digital|transformation|automation|devops|moderniz)/i,
    score: 78,
  },
  { re: /\b(products?|solutions?|services?)\b/i, score: 72 },
  { re: /\b(about|company|who[\s_-]?we[\s_-]?are)\b/i, score: 68 },
  { re: /\b(blog|news|insights|articles|press|resources)\b/i, score: 60 },
];

const CAREERS_PATH_RE =
  /^\/(careers?|jobs?|job|hiring|join-?us|work-?with-?us)(\/|$)/i;

export type TechCrawlLink = { url: string; text: string; score: number };

export type TechCrawlResult = {
  startUrl: string;
  pagesVisited: string[];
  techKeywords: string[];
  buyingHints: string[];
  servicesHints: string[];
  careersUrl?: string;
  careersMentionsHiring: boolean;
  rawSnippets: string[];
  usedFallbackPaths: boolean;
};

function urlKey(href: string): string {
  try {
    const u = new URL(href);
    u.hash = "";
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return href.replace(/\/$/, "").toLowerCase();
  }
}

function sameRegistrableHost(a: string, b: string): boolean {
  const na = a.replace(/^www\./, "").toLowerCase();
  const nb = b.replace(/^www\./, "").toLowerCase();
  return na === nb || na.endsWith(`.${nb}`) || nb.endsWith(`.${na}`);
}

/**
 * Prefer origin homepage for crawl seed. Careers/jobs deep links
 * (e.g. aloyoga.com/careers) normalize to aloyoga.com/.
 */
export function normalizeTechCrawlStartUrl(websiteUrl: string): string {
  try {
    const u = new URL(websiteUrl);
    if (!/^https?:$/i.test(u.protocol)) return websiteUrl;
    // Always crawl from site root so nav links are discoverable
    return `${u.protocol}//${u.host}/`;
  } catch {
    return websiteUrl;
  }
}

export function scoreTechCrawlLink(href: string, text = ""): number {
  const pathAndText = (() => {
    try {
      const u = new URL(href);
      return `${u.pathname} ${u.search} ${text}`;
    } catch {
      return `${href} ${text}`;
    }
  })();
  let best = 0;
  for (const { re, score } of TECH_CRAWL_LINK_SCORES) {
    if (re.test(pathAndText) && score > best) best = score;
  }
  return best;
}

export function shouldSkipTechCrawlUrl(
  href: string,
  originHost: string,
): boolean {
  const lower = href.trim().toLowerCase();
  if (!lower || lower.startsWith("mailto:") || lower.startsWith("tel:")) {
    return true;
  }
  if (lower.startsWith("javascript:") || lower.startsWith("data:")) return true;
  try {
    const u = new URL(href);
    if (!/^https?:$/i.test(u.protocol)) return true;
    if (TECH_CRAWL_SOCIAL_HOST_RE.test(u.hostname)) return true;
    if (!sameRegistrableHost(u.hostname, originHost)) return true;
    const blob = `${u.pathname}${u.search}`;
    if (TECH_CRAWL_SKIP_RE.test(blob)) return true;
    if (/\.(pdf|zip|docx?|xlsx?|pptx?)($|\?)/i.test(u.pathname)) return true;
    return false;
  } catch {
    return true;
  }
}

/** Same-origin nav links from the current page, scored for tech-signal relevance. */
export async function extractTechCrawlLinks(
  page: Page,
  originHost: string,
): Promise<TechCrawlLink[]> {
  const raw = (await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#")) continue;
      let abs = "";
      try { abs = new URL(href, location.href).href; } catch { continue; }
      if (!/^https?:/i.test(abs)) continue;
      const key = abs.replace(/#.*$/, "").replace(/\\/$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const text = (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      out.push({ url: abs.split("#")[0], text });
      if (out.length >= 80) break;
    }
    return out;
  })()`)) as Array<{ url: string; text: string }>;

  const scored: TechCrawlLink[] = [];
  for (const item of raw) {
    if (shouldSkipTechCrawlUrl(item.url, originHost)) continue;
    const score = scoreTechCrawlLink(item.url, item.text);
    if (score <= 0) continue;
    scored.push({ url: item.url, text: item.text, score });
  }
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return scored;
}

/**
 * Bounded same-origin crawl from the company homepage for stack/buying signals.
 * Discovers careers/about/blog/product pages via in-site links; falls back to a
 * small hardcoded path list only when no scored links are found.
 */
export async function crawlTechSignals(
  page: Page,
  websiteUrl: string,
  opts?: {
    maxPages?: number;
    careersUrl?: string;
    delayMs?: number;
  },
): Promise<TechCrawlResult> {
  const maxPages = Math.max(
    1,
    opts?.maxPages ?? envInt("LEAD_TECH_CRAWL_MAX_PAGES", 8),
  );
  const delayMs = opts?.delayMs ?? 0;
  const startUrl = normalizeTechCrawlStartUrl(websiteUrl);

  let originHost = "";
  try {
    originHost = new URL(startUrl).hostname;
  } catch {
    return {
      startUrl,
      pagesVisited: [],
      techKeywords: [],
      buyingHints: [],
      servicesHints: [],
      careersMentionsHiring: false,
      rawSnippets: [],
      usedFallbackPaths: false,
    };
  }

  const stackKeywords = new Set<string>();
  const buyingHints = new Set<string>();
  const servicesHints = new Set<string>();
  const rawSnippets: string[] = [];
  const pagesVisited: string[] = [];
  const visitedKeys = new Set<string>();
  let careersUrl = opts?.careersUrl;
  let careersMentionsHiring = false;
  let usedFallbackPaths = false;

  type Queued = { url: string; score: number };
  const queue: Queued[] = [];
  const queuedKeys = new Set<string>();

  const enqueue = (url: string, score: number) => {
    if (shouldSkipTechCrawlUrl(url, originHost)) return;
    const key = urlKey(url);
    if (visitedKeys.has(key) || queuedKeys.has(key)) return;
    queuedKeys.add(key);
    queue.push({ url, score });
  };

  enqueue(startUrl, 1000);

  // Preserve deep careers URL if websiteUrl pointed at /careers
  try {
    const original = new URL(websiteUrl);
    if (
      CAREERS_PATH_RE.test(original.pathname) ||
      /\/(careers?|jobs?)(\/|$)/i.test(original.pathname)
    ) {
      enqueue(original.href, 100);
    }
  } catch {
    /* ignore */
  }
  if (opts?.careersUrl) enqueue(opts.careersUrl, 100);

  const absorb = (web: WebPageExtract) => {
    for (const k of web.techKeywords) stackKeywords.add(k);
    for (const h of web.buyingHints) buyingHints.add(h);
    for (const s of web.servicesHints) servicesHints.add(s);
    if (web.snippet) rawSnippets.push(web.snippet.slice(0, 200));
    if (web.careersUrl) careersUrl = careersUrl || web.careersUrl;
    if (
      /career|job|hiring/i.test(web.url) ||
      web.buyingHints.some((h) => /hir|career|job|open role/i.test(h))
    ) {
      careersMentionsHiring =
        careersMentionsHiring || web.ok || web.buyingHints.length > 0;
    }
  };

  let harvestedScoredLinks = 0;

  while (queue.length > 0 && pagesVisited.length < maxPages) {
    queue.sort((a, b) => b.score - a.score);
    const next = queue.shift()!;
    queuedKeys.delete(urlKey(next.url));
    const key = urlKey(next.url);
    if (visitedKeys.has(key)) continue;
    visitedKeys.add(key);

    const isHome = urlKey(next.url) === urlKey(startUrl);
    const web = await extractWebPage(page, next.url, 25_000, {
      settle: isHome || pagesVisited.length === 0 ? "read_website" : "nav",
    });
    pagesVisited.push(next.url);
    absorb(web);

    if (web.ok) {
      const links = await extractTechCrawlLinks(page, originHost);
      harvestedScoredLinks += links.length;
      for (const link of links) {
        enqueue(link.url, link.score);
      }
    }

    if (pagesVisited.length < maxPages && queue.length > 0) {
      await humanDelay("idle_micro", {
        minMs: Math.min(delayMs || 400, 800),
      });
    }
  }

  // Hardcoded path fallback only when crawl found no in-site signal links
  if (harvestedScoredLinks === 0 && pagesVisited.length < maxPages) {
    usedFallbackPaths = true;
    const fallback = [
      ...guessCareersUrl(startUrl).slice(0, 2),
      ...guessSignalUrls(startUrl),
    ];
    for (const url of fallback) {
      if (pagesVisited.length >= maxPages) break;
      const key = urlKey(url);
      if (visitedKeys.has(key)) continue;
      visitedKeys.add(key);
      const web = await extractWebPage(page, url, 25_000, { settle: "nav" });
      pagesVisited.push(url);
      absorb(web);
      if (pagesVisited.length < maxPages) {
        await humanDelay("idle_micro", {
          minMs: Math.min(delayMs || 400, 800),
        });
      }
    }
  }

  return {
    startUrl,
    pagesVisited,
    techKeywords: [...stackKeywords],
    buyingHints: [...buyingHints],
    servicesHints: [...servicesHints],
    careersUrl,
    careersMentionsHiring,
    rawSnippets: rawSnippets.slice(0, 5),
    usedFallbackPaths,
  };
}

export function officialSiteSearchHint(companyName: string): string {
  return `"${companyName}" official site`;
}

export { TECH_TERMS, BUYING_HINTS, SERVICE_HINTS };
