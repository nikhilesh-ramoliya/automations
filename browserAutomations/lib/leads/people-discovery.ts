/**
 * Decision-maker discovery waterfall:
 * 1. Website leadership crawl (scored About/Team/Leadership links; real titles)
 * 2. Web search → LinkedIn `/in/` (Brave/Bing API first; HTML SERP only if opted in)
 * 3. Filtered LinkedIn company employees (keywords + title filters)
 * 4. Optional global LinkedIn people search (last resort)
 *
 * Rejects People-tab noise: "3rd+ degree", "follows this page", empty titles,
 * department / non-person names.
 */

import type { Page } from "playwright";
import {
  assertJobRuntime,
  assertWithinCap,
  humanDelay,
  recordAction,
} from "../linkedin-safety.js";
import { assertNotLogin } from "./browser.js";
import { skipWebSearch } from "./env.js";
import {
  hasAnySearchPath,
  resolveApiProviders,
  searchWeb,
  shouldAttemptHtmlSearch,
  type SearchHit,
} from "./search-api.js";
import type { CompanyRecord, PersonSource } from "./types.js";
import {
  detectSearchChallenge,
  isSearchEngineBlocked,
  isWebSearchSoftStopped,
  noteSearchChallenge,
  remainingWebSearches,
  softStopWebSearch,
  tryConsumeWebSearch,
  unwrapSearchRedirect,
  webPace,
  withWebSearchLock,
  type SearchEngine,
} from "./web.js";

export type DiscoveredPerson = {
  name: string;
  title?: string;
  linkedinUrl?: string;
  email?: string;
  location?: string;
  source: PersonSource;
  /** Higher = more likely decision maker */
  rankScore: number;
};

const TITLE_QUERY =
  'CEO OR CTO OR CIO OR Founder OR "VP Engineering" OR "Head of IT" OR Director';

const WEB_SEARCH_TITLE_QUERY =
  'CEO OR CTO OR Founder OR "VP Engineering" OR CIO OR "Head of IT"';

const LEADERSHIP_PATHS = [
  "/about",
  "/about-us",
  "/team",
  "/leadership",
  "/company",
  "/our-team",
  "/people",
  "/management",
  "/executives",
  "/founders",
];

const LEADERSHIP_CRAWL_SKIP_RE =
  /logout|sign[\s_-]?out|cart|checkout|login|sign[\s_-]?in|register|wp-admin|careers?\/apply|\.pdf($|\?)/i;

const LEADERSHIP_LINK_SCORES: { re: RegExp; score: number }[] = [
  { re: /\b(leadership|executives?|management.?team|board.?of.?directors?)\b/i, score: 100 },
  { re: /\b(founders?|partners?|our.?people)\b/i, score: 96 },
  { re: /\b(our.?team|the.?team|team|staff|people)\b/i, score: 92 },
  { re: /\b(about.?us|about|who.?we.?are|company|meet.?us)\b/i, score: 78 },
];

const DECISION_TITLE_PATTERNS: { re: RegExp; score: number }[] = [
  { re: /\b(chief\s+executive|ceo)\b/i, score: 100 },
  { re: /\b(chief\s+technology|cto)\b/i, score: 98 },
  { re: /\b(chief\s+information|cio)\b/i, score: 96 },
  { re: /\b(chief\s+digital|cdo)\b/i, score: 94 },
  { re: /\b(chief\s+operating|coo)\b/i, score: 92 },
  { re: /\b(chief\s+financial|cfo)\b/i, score: 90 },
  { re: /\bco-?founder\b/i, score: 95 },
  { re: /\bfounder\b/i, score: 94 },
  { re: /\bvp\s+(of\s+)?engineering\b/i, score: 88 },
  { re: /\bvice\s+president\s+(of\s+)?engineering\b/i, score: 88 },
  { re: /\bhead\s+of\s+it\b/i, score: 86 },
  { re: /\bhead\s+of\s+engineering\b/i, score: 86 },
  { re: /\bhead\s+of\s+(technology|tech|product|digital)\b/i, score: 84 },
  { re: /\b(vp|vice\s+president)\b/i, score: 78 },
  { re: /\bdirector\s+(of\s+)?(it|engineering|technology|digital|product)\b/i, score: 76 },
  { re: /\bmanaging\s+director\b/i, score: 82 },
  { re: /\bdirector\b/i, score: 70 },
  { re: /\bowner\b/i, score: 72 },
  { re: /\bpresident\b/i, score: 80 },
  { re: /\bgeneral\s+manager\b/i, score: 68 },
];

/** Titles that are LinkedIn UI chrome, not job titles. */
const NOISE_TITLE_RE =
  /\b(\d+(st|nd|rd|th)\+?\s*degree|degree\s+connection|mutual\s+connection|follows?\s+this\s+page|followers?|connections?|premium|influencer|open\s+to\s+work)\b/i;

/** Names that are departments, CTAs, or follower chrome — not people. */
const NOISE_NAME_RE =
  /\b(follows?\s+this\s+page|degree\s+connection|view\s+profile|linkedin|finance\s*&\s*accounting|human\s+resources|customer\s+success|our\s+team|meet\s+the|leadership\s+team)\b/i;

const DEPT_OR_ROLE_ONLY_NAME_RE =
  /^(finance|accounting|engineering|marketing|sales|operations|legal|support|product|design|hr|it|team|department|division|staff|employees?|members?|partners?|investors?|clients?|customers?)(\s*[&/]\s*(finance|accounting|engineering|marketing|sales|operations|legal|hr|it|product))?$/i;

export function scoreDecisionTitle(title?: string): number {
  if (!title?.trim()) return 0;
  if (NOISE_TITLE_RE.test(title)) return 0;
  let best = 0;
  for (const { re, score } of DECISION_TITLE_PATTERNS) {
    if (re.test(title) && score > best) best = score;
  }
  return best;
}

export function isLikelyDecisionMaker(title?: string, minScore = 68): boolean {
  return scoreDecisionTitle(title) >= minScore;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikePersonName(name: string, opts?: { requireCaps?: boolean }): boolean {
  const n = name.trim();
  if (n.length < 3 || n.length > 80) return false;
  if (/^(meet|our|the|team|leadership|about|company|home|contact|careers|join)/i.test(n)) {
    return false;
  }
  if (NOISE_NAME_RE.test(n)) return false;
  if (DEPT_OR_ROLE_ONLY_NAME_RE.test(n)) return false;
  if (/linkedin|twitter|facebook|instagram|youtube/i.test(n)) return false;
  if (/\d{3,}|@|https?:/i.test(n)) return false;
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return false;
  if (opts?.requireCaps === false) {
    return parts.every((p) => /^[\p{L}'’.-]+$/u.test(p));
  }
  const caps = parts.filter(
    (p) =>
      /^[A-Z][a-z'’.-]+$/.test(p) ||
      /^[A-Z]\.?$/.test(p) ||
      /^[A-Z]{2,}(?:'[A-Z]+)?$/.test(p),
  );
  return caps.length >= 2;
}

/**
 * Strict gate for decision-maker candidates.
 * Requires a real person name + decision-maker title pattern; rejects LI chrome.
 */
export function isValidDecisionMaker(
  name: string,
  title?: string,
  opts?: { minTitleScore?: number; requireCaps?: boolean },
): boolean {
  const minScore = opts?.minTitleScore ?? 60;
  if (!looksLikePersonName(name, { requireCaps: opts?.requireCaps })) return false;
  if (!title?.trim()) return false;
  if (NOISE_TITLE_RE.test(title)) return false;
  if (NOISE_NAME_RE.test(title)) return false;
  return scoreDecisionTitle(title) >= minScore;
}

export function rankAndCapPeople(
  people: DiscoveredPerson[],
  max: number,
): DiscoveredPerson[] {
  const byKey = new Map<string, DiscoveredPerson>();
  for (const p of people) {
    if (!isValidDecisionMaker(p.name, p.title, { requireCaps: false, minTitleScore: 50 })) {
      continue;
    }
    const key =
      (p.linkedinUrl &&
        p.linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase()) ||
      normalizeName(p.name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || p.rankScore > existing.rankScore) {
      byKey.set(key, p);
    } else if (existing && !existing.title && p.title) {
      byKey.set(key, {
        ...existing,
        title: p.title,
        rankScore: Math.max(existing.rankScore, p.rankScore),
      });
    } else if (existing && !existing.linkedinUrl && p.linkedinUrl) {
      byKey.set(key, { ...existing, linkedinUrl: p.linkedinUrl });
    } else if (existing && !existing.email && p.email) {
      byKey.set(key, { ...existing, email: p.email });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.rankScore - a.rankScore || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, max));
}

export function mergePeople(
  existing: DiscoveredPerson[],
  incoming: DiscoveredPerson[],
  max: number,
): DiscoveredPerson[] {
  return rankAndCapPeople([...existing, ...incoming], max);
}

export function leadershipPageCandidates(websiteUrl: string): string[] {
  try {
    const u = new URL(websiteUrl);
    const base = `${u.protocol}//${u.host}`;
    return LEADERSHIP_PATHS.map((p) => `${base}${p}`);
  } catch {
    return [];
  }
}

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

function scoreLeadershipLink(href: string, text = ""): number {
  const pathAndText = (() => {
    try {
      const u = new URL(href);
      return `${u.pathname} ${u.search} ${text}`;
    } catch {
      return `${href} ${text}`;
    }
  })();
  let best = 0;
  for (const { re, score } of LEADERSHIP_LINK_SCORES) {
    if (re.test(pathAndText) && score > best) best = score;
  }
  return best;
}

function shouldSkipLeadershipUrl(href: string, originHost: string): boolean {
  const lower = href.trim().toLowerCase();
  if (!lower || lower.startsWith("mailto:") || lower.startsWith("tel:")) return true;
  if (lower.startsWith("javascript:") || lower.startsWith("data:")) return true;
  try {
    const u = new URL(href);
    if (!/^https?:$/i.test(u.protocol)) return true;
    if (/facebook\.com|twitter\.com|instagram\.com|youtube\.com/i.test(u.hostname)) {
      return true;
    }
    if (!sameRegistrableHost(u.hostname, originHost)) return true;
    if (LEADERSHIP_CRAWL_SKIP_RE.test(`${u.pathname}${u.search}`)) return true;
    return false;
  } catch {
    return true;
  }
}

/** Collect scored team/about/leadership links from the current page. */
export async function discoverTeamLinksFromPage(page: Page): Promise<
  Array<{ url: string; score: number }>
> {
  const originHost = (() => {
    try {
      return new URL(page.url()).hostname;
    } catch {
      return "";
    }
  })();

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

  const scored: Array<{ url: string; score: number }> = [];
  for (const item of raw) {
    if (!originHost || shouldSkipLeadershipUrl(item.url, originHost)) continue;
    const score = scoreLeadershipLink(item.url, item.text);
    if (score <= 0) continue;
    scored.push({ url: item.url, score });
  }
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return scored.slice(0, 16);
}

/**
 * Heuristic name+title extraction from a public page (cards, headings, mailto, /in/ links).
 */
export async function extractPeopleFromPage(page: Page): Promise<DiscoveredPerson[]> {
  const raw = (await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();
    const TITLE_RE = /\\b(CEO|CTO|CIO|CFO|COO|CDO|Founder|Co-Founder|Co Founder|President|Owner|Managing Director|VP|Vice President|Director|Head of [A-Za-z &/]{2,40}|Chief [A-Za-z ]{2,40})\\b/i;
    const NAME_STOP = /^(meet|our|the|team|leadership|about|company|home|contact|careers|join|learn|read|view|follow|linkedin|finance)/i;

    function push(name, title, linkedinUrl, email) {
      const n = (name || "").replace(/\\s+/g, " ").trim();
      if (!n || n.length < 3 || n.length > 80) return;
      if (NAME_STOP.test(n)) return;
      if (/linkedin|twitter|facebook|instagram|follows this page/i.test(n)) return;
      const parts = n.split(/\\s+/).filter(Boolean);
      if (parts.length < 2 || parts.length > 5) return;
      const key = (linkedinUrl || n).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        name: n.slice(0, 100),
        title: title ? String(title).replace(/\\s+/g, " ").trim().slice(0, 120) : undefined,
        linkedinUrl: linkedinUrl || undefined,
        email: email || undefined,
      });
    }

    for (const a of Array.from(document.querySelectorAll('a[href^="mailto:"]'))) {
      const href = a.getAttribute("href") || "";
      const email = decodeURIComponent(href.replace(/^mailto:/i, "").split("?")[0] || "").trim();
      let name = (a.textContent || "").replace(/\\s+/g, " ").trim();
      if (!name || /@/.test(name)) {
        const parent = a.closest("li, article, .card, .team-member, figure, div") || a.parentElement;
        const heading = parent && parent.querySelector("h1,h2,h3,h4,h5,strong,b,.name");
        name = ((heading && heading.textContent) || "").replace(/\\s+/g, " ").trim() || name;
      }
      const parent = a.closest("li, article, .card, .team-member, figure, div") || a.parentElement;
      const text = ((parent && parent.textContent) || "").replace(/\\s+/g, " ").trim();
      const tm = text.match(TITLE_RE);
      push(name, tm ? tm[0] : undefined, undefined, email || undefined);
    }

    for (const a of Array.from(document.querySelectorAll('a[href*="linkedin.com/in/"]'))) {
      const href = a.href || "";
      const m = href.match(/linkedin\\.com\\/in\\/([^/?#]+)/i);
      if (!m) continue;
      const slug = decodeURIComponent(m[1]).toLowerCase();
      const liUrl = "https://www.linkedin.com/in/" + slug + "/";
      let name = (a.getAttribute("aria-label") || a.textContent || "").replace(/\\s+/g, " ").trim();
      const card = a.closest("li, article, .card, .team-member, figure, div") || a.parentElement;
      if (!name || name.length < 3 || /linkedin|view|profile/i.test(name)) {
        const h = card && card.querySelector("h1,h2,h3,h4,h5,strong,b,.name,[class*='name']");
        name = ((h && h.textContent) || "").replace(/\\s+/g, " ").trim();
      }
      const text = ((card && card.textContent) || "").replace(/\\s+/g, " ").trim();
      const tm = text.match(TITLE_RE);
      push(name, tm ? tm[0] : undefined, liUrl, undefined);
    }

    const cardSels = [
      "[class*='team'] article",
      "[class*='team'] li",
      "[class*='leadership'] article",
      "[class*='leadership'] li",
      "[class*='people'] article",
      ".team-member",
      ".member",
      "[itemtype*='Person']",
    ];
    for (const sel of cardSels) {
      for (const card of Array.from(document.querySelectorAll(sel))) {
        const h = card.querySelector("h1,h2,h3,h4,h5,h6,strong,b,.name,[class*='name']");
        const name = ((h && h.textContent) || "").replace(/\\s+/g, " ").trim();
        const text = (card.textContent || "").replace(/\\s+/g, " ").trim();
        const tm = text.match(TITLE_RE);
        let title = tm ? tm[0] : "";
        if (!title) {
          const sub = card.querySelector("p, .title, [class*='title'], [class*='role'], [class*='position']");
          title = ((sub && sub.textContent) || "").replace(/\\s+/g, " ").trim().slice(0, 120);
        }
        push(name, title || undefined, undefined, undefined);
      }
    }

    for (const h of Array.from(document.querySelectorAll("h2,h3,h4"))) {
      const name = (h.textContent || "").replace(/\\s+/g, " ").trim();
      if (!name || name.length > 60) continue;
      let title = "";
      let sib = h.nextElementSibling;
      for (let i = 0; i < 3 && sib; i++) {
        const t = (sib.textContent || "").replace(/\\s+/g, " ").trim();
        const tm = t.match(TITLE_RE);
        if (tm) { title = tm[0]; break; }
        if (t.length > 3 && t.length < 80 && TITLE_RE.test(t)) { title = t; break; }
        sib = sib.nextElementSibling;
      }
      if (title) push(name, title, undefined, undefined);
    }

    return out.slice(0, 40);
  })()`)) as Array<{
    name: string;
    title?: string;
    linkedinUrl?: string;
    email?: string;
  }>;

  return raw
    .filter((p) => isValidDecisionMaker(p.name, p.title, { requireCaps: false, minTitleScore: 60 }))
    .map((p) => ({
      name: p.name,
      title: p.title,
      linkedinUrl: p.linkedinUrl,
      email: p.email,
      source: "website" as const,
      rankScore: scoreDecisionTitle(p.title),
    }));
}

/**
 * Visit company website leadership/team/about pages and extract decision makers.
 * Priority queue of scored in-site links (like tech crawl); requires real titles.
 */
export async function discoverPeopleFromWebsite(
  page: Page,
  company: CompanyRecord,
  maxPeople: number,
  opts?: { maxPages?: number },
): Promise<{ people: DiscoveredPerson[]; pagesVisited: string[] }> {
  const website = company.websiteUrl?.trim();
  if (!website) return { people: [], pagesVisited: [] };

  const maxPages = opts?.maxPages ?? 6;
  const pagesVisited: string[] = [];
  const collected: DiscoveredPerson[] = [];

  let originHost = "";
  try {
    originHost = new URL(website).hostname;
  } catch {
    return { people: [], pagesVisited: [] };
  }

  type Queued = { url: string; score: number };
  const queue: Queued[] = [];
  const visitedKeys = new Set<string>();
  const queuedKeys = new Set<string>();

  const enqueue = (url: string, score: number) => {
    if (shouldSkipLeadershipUrl(url, originHost)) return;
    const key = urlKey(url);
    if (visitedKeys.has(key) || queuedKeys.has(key)) return;
    queuedKeys.add(key);
    queue.push({ url, score });
  };

  try {
    const home = `${new URL(website).protocol}//${new URL(website).host}/`;
    enqueue(home, 1000);
  } catch {
    enqueue(website, 1000);
  }
  for (const p of leadershipPageCandidates(website)) enqueue(p, 85);

  while (queue.length > 0 && pagesVisited.length < maxPages) {
    queue.sort((a, b) => b.score - a.score);
    const next = queue.shift()!;
    queuedKeys.delete(urlKey(next.url));
    const key = urlKey(next.url);
    if (visitedKeys.has(key)) continue;
    visitedKeys.add(key);

    try {
      const res = await page.goto(next.url, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
      await humanDelay("read_website", { minMs: 800, maxMs: 4000 });
      const status = res?.status();
      if (status !== undefined && (status < 200 || status >= 400)) continue;
      pagesVisited.push(next.url);

      const links = await discoverTeamLinksFromPage(page);
      for (const link of links) enqueue(link.url, link.score);

      const found = await extractPeopleFromPage(page);
      collected.push(...found);
    } catch {
      /* skip failed page */
    }
    if (rankAndCapPeople(collected, maxPeople).length >= maxPeople) break;
  }

  const people = rankAndCapPeople(collected, maxPeople);
  return { people, pagesVisited };
}

function buildSearchUrl(engine: SearchEngine, q: string): string {
  const enc = encodeURIComponent(q);
  if (engine === "duckduckgo") {
    return `https://html.duckduckgo.com/html/?q=${enc}`;
  }
  return `https://www.bing.com/search?q=${enc}`;
}

function parseNameTitleFromSerp(text: string): { name?: string; title?: string } {
  const cleaned = text
    .replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  // "Jane Doe - CEO at Acme" / "Jane Doe | CTO | Acme"
  const m = cleaned.match(
    /^([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){1,3})\s*[-–—|·]\s*(.+)$/u,
  );
  if (m) {
    return { name: m[1]!.trim(), title: m[2]!.trim().slice(0, 120) };
  }
  return {};
}

function nameFromLinkedInSlug(slug: string): string | undefined {
  const parts = decodeURIComponent(slug)
    .replace(/-\d+$/, "")
    .split("-")
    .filter((p) => p && !/^\d+$/.test(p));
  if (parts.length < 2 || parts.length > 4) return undefined;
  const name = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
  return looksLikePersonName(name, { requireCaps: false }) ? name : undefined;
}

function peopleFromSearchHits(
  hits: Array<{ href?: string; url?: string; title: string; snippet: string }>,
  maxPeople: number,
): DiscoveredPerson[] {
  const collected: DiscoveredPerson[] = [];
  for (const row of hits) {
    let href = (row.href ?? row.url ?? "").trim();
    if (!href) continue;
    if (href.startsWith("/ck/")) href = `https://www.bing.com${href}`;
    else if (href.startsWith("/url?")) href = `https://www.google.com${href}`;
    else if (/^linkedin\.com\/in\//i.test(href)) href = `https://www.${href}`;
    const unwrapped = unwrapSearchRedirect(href);
    const m = unwrapped.match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (!m) continue;
    const slug = decodeURIComponent(m[1]!).toLowerCase();
    if (/\/dir\/|\/pub\//i.test(unwrapped)) continue;
    const linkedinUrl = `https://www.linkedin.com/in/${slug}/`;
    const blob = `${row.title} ${row.snippet}`;
    let { name, title } = parseNameTitleFromSerp(row.title);
    if (!title) {
      const tm = blob.match(
        /\b(CEO|CTO|CIO|CFO|COO|Founder|Co-Founder|President|VP(?:\s+of)?\s+Engineering|Vice President|Head of IT|Head of Engineering|Director(?:\s+of)?(?:\s+\w+)?)\b/i,
      );
      title = tm ? tm[0] : undefined;
    }
    if (!title && /\s[-–—]\s/.test(row.title)) {
      const after = row.title.split(/\s[-–—]\s/).slice(1).join(" - ");
      const tm = after.match(
        /\b(CEO|CTO|CIO|CFO|COO|Founder|Co-Founder|President|VP|Vice President|Director|Head of [^|·\n]{2,40})\b/i,
      );
      if (tm) title = tm[0];
      else if (after.length > 2 && after.length < 80) {
        title = after.replace(/\s*[|].*$/, "").trim();
      }
    }
    if (!name) name = nameFromLinkedInSlug(slug);
    if (title && NOISE_TITLE_RE.test(title)) {
      const tm = row.snippet.match(
        /\b(CEO|CTO|CIO|CFO|COO|Founder|Co-Founder|VP|Vice President|Director|Head of [^·\n,]{2,40})\b/i,
      );
      title = tm ? tm[0] : undefined;
    }
    if (!name || !looksLikePersonName(name, { requireCaps: false })) continue;
    if (!title || NOISE_TITLE_RE.test(title)) {
      const inferred = blob.match(
        /\b(CEO|CTO|CIO|CFO|COO|Co-?Founder|Founder|President)\b/i,
      );
      if (inferred) title = inferred[0];
      else continue;
    }
    if (
      !isValidDecisionMaker(name, title, {
        requireCaps: false,
        minTitleScore: 60,
      })
    ) {
      continue;
    }
    collected.push({
      name,
      title,
      linkedinUrl,
      source: "web_search",
      rankScore: scoreDecisionTitle(title) + 5,
    });
    if (rankAndCapPeople(collected, maxPeople).length >= maxPeople) break;
  }
  return rankAndCapPeople(collected, maxPeople);
}

async function discoverPeopleViaSearchApi(
  company: CompanyRecord,
  maxPeople: number,
  queries: string[],
): Promise<{
  people: DiscoveredPerson[];
  searchesUsed: number;
  query?: string;
  reason?: string;
}> {
  const providers = resolveApiProviders();
  if (providers.length === 0) {
    return { people: [], searchesUsed: 0, reason: "no_search_api_key" };
  }

  const collected: DiscoveredPerson[] = [];
  let searchesUsed = 0;
  let lastQuery: string | undefined;
  let lastReason: string | undefined;

  for (const q of queries) {
    if (rankAndCapPeople(collected, maxPeople).length >= maxPeople) break;
    if (remainingWebSearches() <= 0) {
      lastReason = "web_search_budget";
      break;
    }

    for (const provider of providers) {
      if (rankAndCapPeople(collected, maxPeople).length >= maxPeople) break;
      if (remainingWebSearches() <= 0) break;

      if (!(await tryConsumeWebSearch())) {
        lastReason = "web_search_budget";
        break;
      }

      searchesUsed += 1;
      lastQuery = q;
      const api = await searchWeb(q, { count: 12, provider });
      if (api.skipped && api.hits.length === 0) {
        lastReason = api.reason ?? `${provider}_error`;
        continue;
      }

      const found = peopleFromSearchHits(
        api.hits.map(
          (h: SearchHit): { url: string; title: string; snippet: string } => ({
            url: h.url,
            title: h.title,
            snippet: h.snippet,
          }),
        ),
        maxPeople,
      );
      for (const p of found) {
        if (!collected.some((c) => c.linkedinUrl === p.linkedinUrl)) {
          collected.push(p);
        }
      }
      if (found.length > 0) {
        return {
          people: rankAndCapPeople(collected, maxPeople),
          searchesUsed,
          query: lastQuery,
        };
      }
      lastReason = "api_no_linkedin_in_results";
    }
  }

  return {
    people: rankAndCapPeople(collected, maxPeople),
    searchesUsed,
    query: lastQuery,
    reason: collected.length ? undefined : lastReason ?? "api_no_result",
  };
}

/**
 * HTML Bing/DDG SERP for LinkedIn `/in/` (last resort when LEAD_HTML_SEARCH).
 * Always sequential. On CAPTCHA: ban engine, one alternate, then soft-stop.
 */
async function discoverPeopleFromHtmlSerp(
  page: Page,
  company: CompanyRecord,
  maxPeople: number,
  queries: string[],
  opts?: { engines?: SearchEngine[] },
): Promise<{
  people: DiscoveredPerson[];
  searchesUsed: number;
  query?: string;
  blocked?: boolean;
  reason?: string;
}> {
  const engines = opts?.engines ?? (["bing", "duckduckgo"] as SearchEngine[]);
  const collected: DiscoveredPerson[] = [];
  let searchesUsed = 0;
  let blocked = false;
  let lastReason: string | undefined;
  let lastQuery: string | undefined;
  let alternateAfterChallengeUsed = false;

  for (const q of queries) {
    if (collected.length >= maxPeople) break;
    if (isWebSearchSoftStopped()) break;
    let gotResults = false;
    for (const engine of engines) {
      if (collected.length >= maxPeople) break;
      if (gotResults) break;
      if (isSearchEngineBlocked(engine)) continue;
      if (isWebSearchSoftStopped()) break;

      const pass = await withWebSearchLock(async () => {
        if (isSearchEngineBlocked(engine) || isWebSearchSoftStopped()) {
          return { kind: "skip" as const, reason: "engine_blocked" };
        }
        if (!(await tryConsumeWebSearch())) {
          return { kind: "skip" as const, reason: "web_search_budget" };
        }

        const searchUrl = buildSearchUrl(engine, q);
        await webPace("search", { minMs: 2500 });
        try {
          await page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          await webPace("search", { minMs: 2000 });
        } catch {
          return { kind: "nav_fail" as const };
        }

        const challenge = await detectSearchChallenge(page);
        if (challenge.challenged) {
          noteSearchChallenge(engine, engines);
          console.warn(
            `  [web-search] CAPTCHA/challenge on ${engine} for ${company.name}` +
              (isWebSearchSoftStopped()
                ? " — soft-stop (no more SERP)"
                : " — trying alternate once if available"),
          );
          return { kind: "challenge" as const, engine };
        }

        const rows = (await page.evaluate(`(() => {
      const out = [];
      const seen = new Set();
      const push = (href, title, snippet) => {
        if (!href) return;
        const key = (href + "|" + (title || "")).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          href,
          title: (title || "").replace(/\\s+/g, " ").trim().slice(0, 160),
          snippet: (snippet || "").replace(/\\s+/g, " ").trim().slice(0, 240),
        });
      };

      const algoBlocks = Array.from(document.querySelectorAll(
        "#b_results .b_algo, li.b_algo, .result, #links .result, div.g",
      ));
      if (algoBlocks.length) {
        for (const block of algoBlocks) {
          const a = block.querySelector("h2 a[href], a.result__a[href], a[href]");
          const cite = block.querySelector("cite");
          const href =
            (a && (a.getAttribute("href") || a.href)) ||
            ((cite && cite.textContent) || "").trim();
          const title = (a && a.textContent) || "";
          const snippetEl = block.querySelector(
            ".b_caption p, .b_algoSlug, .result__snippet, .b_lineclamp2, .b_lineclamp3, p",
          );
          const snippet = (snippetEl && snippetEl.textContent) || "";
          push(href, title, snippet);
          if (out.length >= 20) break;
        }
      }

      if (out.length === 0) {
        for (const a of Array.from(document.querySelectorAll(
          "#b_results a[href], #links a[href], #b_content a[href], main a[href]",
        ))) {
          const href = a.getAttribute("href") || "";
          if (!href) continue;
          if (
            !/^https?:/i.test(href) &&
            !href.startsWith("/ck/") &&
            !href.startsWith("/url?") &&
            !/linkedin\\.com\\/in\\//i.test(href)
          ) {
            continue;
          }
          push(href, (a.textContent || "").trim(), "");
          if (out.length >= 30) break;
        }
      }

      for (const cite of Array.from(document.querySelectorAll("cite"))) {
        const t = (cite.textContent || "").trim();
        if (/linkedin\\.com\\/in\\//i.test(t)) {
          const m = t.match(/https?:\\/\\/\\S*linkedin\\.com\\/in\\/[^\\s]+/i)
            || t.match(/linkedin\\.com\\/in\\/[^\\s/]+/i);
          if (m) push(m[0].startsWith("http") ? m[0] : "https://" + m[0], "", "");
        }
      }
      return out;
    })()`)) as Array<{ href: string; title: string; snippet: string }>;

        return { kind: "ok" as const, rows };
      });

      if (pass.kind === "skip") {
        lastReason = pass.reason;
        if (pass.reason === "web_search_budget") break;
        continue;
      }

      searchesUsed += 1;
      lastQuery = q;

      if (pass.kind === "nav_fail") {
        lastReason = "navigation_failed";
        continue;
      }
      if (pass.kind === "challenge") {
        blocked = true;
        lastReason = `serp_challenge:${pass.engine}`;
        if (!alternateAfterChallengeUsed) {
          alternateAfterChallengeUsed = true;
          const alt = engines.find(
            (e) => e !== pass.engine && !isSearchEngineBlocked(e),
          );
          if (alt && !isWebSearchSoftStopped()) {
            continue;
          }
        }
        break;
      }

      const found = peopleFromSearchHits(pass.rows, maxPeople);
      for (const p of found) {
        if (!collected.some((c) => c.linkedinUrl === p.linkedinUrl)) {
          collected.push(p);
        }
      }
      if (found.length > 0) gotResults = true;

      if (rankAndCapPeople(collected, maxPeople).length >= maxPeople) break;
      await webPace("idle_micro", { minMs: 800 });
    }
    if (gotResults) break;
    if (blocked && alternateAfterChallengeUsed) break;
  }

  if (blocked) {
    softStopWebSearch(
      "CAPTCHA during people web-search — skipping further SERP",
    );
  }

  return {
    people: rankAndCapPeople(collected, maxPeople),
    searchesUsed,
    query: lastQuery,
    blocked: blocked || undefined,
    reason: lastReason,
  };
}

/**
 * Find decision makers via web search → LinkedIn `/in/`.
 * Priority: Brave/Bing API → HTML SERP only if LEAD_HTML_SEARCH and API failed.
 * Soft-fails clearly — never CAPTCHA-loops.
 */
export async function discoverPeopleFromWebSearch(
  page: Page | null,
  company: CompanyRecord,
  maxPeople: number,
  opts?: { engines?: SearchEngine[] },
): Promise<{
  people: DiscoveredPerson[];
  searchesUsed: number;
  query?: string;
  blocked?: boolean;
  reason?: string;
}> {
  if (skipWebSearch()) {
    return { people: [], searchesUsed: 0, reason: "LEAD_SKIP_WEB_SEARCH" };
  }
  if (!hasAnySearchPath()) {
    console.warn(
      "  [web-search] No people search path: set BRAVE_SEARCH_API_KEY or BING_SEARCH_API_KEY," +
        " or LEAD_HTML_SEARCH=true. Skipping web→LinkedIn lookup.",
    );
    return { people: [], searchesUsed: 0, reason: "no_search_provider" };
  }
  if (isWebSearchSoftStopped() || remainingWebSearches() <= 0) {
    return {
      people: [],
      searchesUsed: 0,
      reason: isWebSearchSoftStopped()
        ? "web_search_soft_stop_captcha"
        : "web_search_budget",
    };
  }

  const queries = [
    `"${company.name}" (CEO OR Founder OR CTO) site:linkedin.com/in`,
    `"${company.name}" (${WEB_SEARCH_TITLE_QUERY}) site:linkedin.com/in`,
  ];

  const providers = resolveApiProviders();
  let searchesUsed = 0;
  let lastQuery: string | undefined;
  let lastReason: string | undefined;

  if (providers.length > 0) {
    const api = await discoverPeopleViaSearchApi(company, maxPeople, queries);
    searchesUsed += api.searchesUsed;
    lastQuery = api.query;
    lastReason = api.reason;
    if (api.people.length > 0) {
      return {
        people: api.people,
        searchesUsed,
        query: lastQuery,
      };
    }
  }

  if (shouldAttemptHtmlSearch() && page) {
    console.log(
      "  [web-search] People HTML SERP fallback (LEAD_HTML_SEARCH=true)",
    );
    const html = await discoverPeopleFromHtmlSerp(
      page,
      company,
      maxPeople,
      queries,
      opts,
    );
    return {
      people: html.people,
      searchesUsed: searchesUsed + html.searchesUsed,
      query: html.query ?? lastQuery,
      blocked: html.blocked,
      reason: html.people.length
        ? undefined
        : html.reason ?? lastReason ?? "web_search_no_result",
    };
  }

  return {
    people: [],
    searchesUsed,
    query: lastQuery,
    reason:
      lastReason ??
      (shouldAttemptHtmlSearch()
        ? "html_unavailable_no_page"
        : providers.length
          ? "api_no_result"
          : "no_search_provider"),
  };
}

function companyPeopleUrl(linkedinUrl: string, keywords?: string): string {
  const base = linkedinUrl.replace(/\/$/, "");
  const peopleBase = /\/people\/?/i.test(base) ? `${base}/` : `${base}/people/`;
  if (!keywords) return peopleBase;
  const u = new URL(peopleBase);
  u.searchParams.set("keywords", keywords);
  return u.href;
}

/**
 * Filtered LinkedIn company employees: keywords on People URL + strict title gate.
 * Rejects follower/connection chrome. Does not fall back to unfiltered People tab.
 */
export async function discoverPeopleFromLinkedInCompany(
  page: Page,
  company: CompanyRecord,
  maxPeople: number,
  delayMs: number,
): Promise<DiscoveredPerson[]> {
  if (!company.linkedinUrl) return [];

  assertJobRuntime();
  assertWithinCap("page_view");
  assertWithinCap("profile_view");

  const keywords = TITLE_QUERY;
  const peopleUrl = companyPeopleUrl(company.linkedinUrl, keywords);
  await page.goto(peopleUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay("read_profile");
  assertNotLogin(page, `company people ${company.name}`);
  recordAction("page_view");
  recordAction("profile_view");

  // If redirected away from people, try company home then People nav with keywords
  if (!/\/people/i.test(page.url())) {
    await page.goto(company.linkedinUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await humanDelay("nav", { minMs: 800 });
    assertNotLogin(page, `company page ${company.name}`);
    recordAction("page_view");

    assertWithinCap("page_view");
    await page.goto(peopleUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await humanDelay("read_profile");
    recordAction("page_view");
    assertNotLogin(page, `company people keywords ${company.name}`);
  }

  // Type keywords into People search box when URL filter did not apply
  const peopleSearch = page
    .locator(
      'input[placeholder*="Search by title" i], input[placeholder*="search" i][aria-label*="people" i], input.org-people__search-input, input[name="keywords"]',
    )
    .first();
  if (await peopleSearch.isVisible({ timeout: 2500 }).catch(() => false)) {
    const current = (await peopleSearch.inputValue().catch(() => "")) || "";
    if (!/CEO|Founder|CTO/i.test(current)) {
      await humanDelay("click");
      await peopleSearch.fill(keywords).catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
      await humanDelay("search", { minMs: Math.min(delayMs, 3000) });
    }
  }

  // Prefer "Current company" / employees filter if UI exposes it
  const currentFilter = page
    .locator(
      'button:has-text("Current"), label:has-text("Current company"), input[type="checkbox"][aria-label*="Current" i]',
    )
    .first();
  if (await currentFilter.isVisible({ timeout: 2500 }).catch(() => false)) {
    await humanDelay("click");
    await currentFilter.click().catch(() => undefined);
    await humanDelay("read_card", { minMs: 600 });
  }

  await page.mouse.wheel(0, 1200);
  await humanDelay("read_card", { minMs: 600 });

  const raw = (await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();
    const NOISE = /\\b(\\d+(st|nd|rd|th)\\+?\\s*degree|degree\\s+connection|follows?\\s+this\\s+page|followers?|mutual\\s+connection)\\b/i;
    const TITLE_RE = /\\b(CEO|CTO|CIO|CFO|COO|Founder|Co-Founder|President|VP|Vice President|Director|Head of [^·\\n,]{2,40}|Managing Director|Owner)\\b/i;

    for (const a of Array.from(document.querySelectorAll('a[href*="/in/"]'))) {
      const href = a.href || "";
      const m = href.match(/linkedin\\.com\\/in\\/([^/?#]+)/i);
      if (!m) continue;
      const slug = decodeURIComponent(m[1]).toLowerCase();
      if (seen.has(slug)) continue;
      const card =
        a.closest("li") ||
        a.closest("[data-chameleon-result-urn]") ||
        a.closest(".org-people-profile-card") ||
        a.closest(".artdeco-list__item") ||
        a.parentElement;
      let name = (a.getAttribute("aria-label") || a.textContent || "")
        .replace(/\\s+/g, " ")
        .trim();
      // Strip " follows this page" / connection chrome from aria-label
      name = name
        .replace(/\\s*follows?\\s+this\\s+page.*$/i, "")
        .replace(/\\s*\\d+(st|nd|rd|th)\\+?\\s*degree.*$/i, "")
        .replace(/\\s+/g, " ")
        .trim();
      if (!name || name.length < 2 || /linkedin|view|profile|follows/i.test(name)) {
        const h = card && card.querySelector(
          "span[aria-hidden='true'], .entity-result__title-text, h3, .artdeco-entity-lockup__title",
        );
        name = ((h && h.textContent) || "").replace(/\\s+/g, " ").trim();
      }
      if (!name || NOISE.test(name) || /follows this page/i.test(name)) continue;

      const text = ((card && card.textContent) || "").replace(/\\s+/g, " ").trim();
      if (NOISE.test(text) && !TITLE_RE.test(text)) {
        // Likely a follower card with no real title
      }

      let title = "";
      // Prefer dedicated subtitle / headline nodes
      const sub = card && card.querySelector(
        ".artdeco-entity-lockup__subtitle, .entity-result__primary-subtitle, .org-people-profile-card__profile-title, .t-14.t-black--light, .t-14.t-normal",
      );
      if (sub) {
        title = (sub.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      }
      if (!title || NOISE.test(title) || title.length < 3) {
        const parts = text.replace(name, "").trim();
        const candidate = parts.split(/\\s{2,}|·/)[0]?.trim().slice(0, 120) || "";
        title = NOISE.test(candidate) ? "" : candidate;
      }
      if (!title || NOISE.test(title)) {
        const tm = text.match(TITLE_RE);
        title = tm ? tm[0] : "";
      }
      if (!title || NOISE.test(title)) continue;

      seen.add(slug);
      out.push({
        name: name.slice(0, 100),
        title: title.slice(0, 120),
        linkedinUrl: "https://www.linkedin.com/in/" + slug + "/",
      });
      if (out.length >= 30) break;
    }
    return out;
  })()`)) as Array<{ name: string; title?: string; linkedinUrl?: string }>;

  const mapped: DiscoveredPerson[] = raw
    .filter((p) => isValidDecisionMaker(p.name, p.title, { requireCaps: false }))
    .map((p) => ({
      name: p.name,
      title: p.title,
      linkedinUrl: p.linkedinUrl,
      source: "linkedin_company" as const,
      rankScore: scoreDecisionTitle(p.title),
    }));

  // No unfiltered fallback — empty is better than follower junk
  return rankAndCapPeople(mapped, maxPeople);
}

/**
 * Global LinkedIn people search (last resort). Still requires valid titles.
 */
export async function discoverPeopleFromLinkedInSearch(
  page: Page,
  company: CompanyRecord,
  maxPeople: number,
  delayMs: number,
): Promise<DiscoveredPerson[]> {
  assertJobRuntime();
  assertWithinCap("search");
  assertWithinCap("page_view");
  const q = encodeURIComponent(`${TITLE_QUERY} ${company.name}`);
  const url = `https://www.linkedin.com/search/results/people/?keywords=${q}&origin=GLOBAL_SEARCH_HEADER`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay("search", { minMs: delayMs });
  assertNotLogin(page, `people search ${company.name}`);
  recordAction("search");
  recordAction("page_view");

  await page.mouse.wheel(0, 900);
  await humanDelay("read_card", { minMs: 400 });

  const raw = (await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();
    const NOISE = /\\b(\\d+(st|nd|rd|th)\\+?\\s*degree|degree\\s+connection|follows?\\s+this\\s+page|followers?)\\b/i;
    for (const a of Array.from(document.querySelectorAll('a[href*="/in/"]'))) {
      const href = a.href || "";
      const m = href.match(/linkedin\\.com\\/in\\/([^/?#]+)/i);
      if (!m) continue;
      const slug = decodeURIComponent(m[1]).toLowerCase();
      if (seen.has(slug)) continue;
      const card =
        a.closest("li") ||
        a.closest('[data-chameleon-result-urn]') ||
        a.closest(".entity-result") ||
        a.parentElement;
      let name = (a.getAttribute("aria-label") || a.textContent || "")
        .replace(/\\s+/g, " ")
        .trim();
      name = name
        .replace(/\\s*follows?\\s+this\\s+page.*$/i, "")
        .replace(/\\s*\\d+(st|nd|rd|th)\\+?\\s*degree.*$/i, "")
        .trim();
      if (!name || name.length < 2) {
        const h = card && card.querySelector("span[aria-hidden='true'], .entity-result__title-text, h3");
        name = ((h && h.textContent) || "").replace(/\\s+/g, " ").trim();
      }
      if (!name || /linkedin|follows/i.test(name) || NOISE.test(name)) continue;
      const text = ((card && card.textContent) || "").replace(/\\s+/g, " ").trim();
      let title = "";
      const sub = card && card.querySelector(
        ".entity-result__primary-subtitle, .artdeco-entity-lockup__subtitle",
      );
      if (sub) title = (sub.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      if (!title || NOISE.test(title)) {
        const parts = text.replace(name, "").trim();
        title = parts.split(/\\s{2,}|·/)[0]?.trim().slice(0, 120) || "";
      }
      if (!title || NOISE.test(title)) {
        const tm = text.match(/\\b(CEO|CTO|CIO|CFO|Founder|Co-Founder|VP|Director|Head of [^·\\n]{2,40})\\b/i);
        title = tm ? tm[0] : "";
      }
      if (!title || NOISE.test(title)) continue;
      seen.add(slug);
      out.push({
        name: name.slice(0, 100),
        title: title.slice(0, 120),
        linkedinUrl: "https://www.linkedin.com/in/" + slug + "/",
      });
      if (out.length >= 20) break;
    }
    return out;
  })()`)) as Array<{ name: string; title?: string; linkedinUrl?: string }>;

  return rankAndCapPeople(
    raw
      .filter((p) => isValidDecisionMaker(p.name, p.title, { requireCaps: false }))
      .map((p) => ({
        name: p.name,
        title: p.title,
        linkedinUrl: p.linkedinUrl,
        source: "linkedin_search" as const,
        rankScore: scoreDecisionTitle(p.title),
      })),
    maxPeople,
  );
}
