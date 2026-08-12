/** Shared env + utility helpers for lead-gen jobs. */

import { resolveOffers } from "./services.js";
import type { LeadRunConfigSnapshot } from "./types.js";

export function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return v === "true" || v === "1";
}

/** Unset / blank → default. Never treat Number("") as 0. */
export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

/** Opt-in fake seed companies/people. Default false — never invent leads. */
export function allowLeadSeeds(): boolean {
  return envBool("LEAD_ALLOW_SEEDS", false);
}

export function envList(name: string, fallback: string[] = []): string[] {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isLeadDryRun(): boolean {
  return envBool("LEAD_DRY_RUN", envBool("DRY_RUN", true));
}

export function isHeadless(): boolean {
  return process.env.HEADLESS === "true" || process.env.HEADLESS === "1";
}

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

export function leadDelayMs(): number {
  return envInt("LEAD_DELAY_MS", 2000);
}

/** Prefer public website research before LinkedIn (default true). */
export function enrichWebFirst(): boolean {
  return envBool("LEAD_ENRICH_WEB_FIRST", true);
}

/** Optionally supplement enrich from LinkedIn company pages (default true). */
export function enrichLinkedIn(): boolean {
  return envBool("LEAD_ENRICH_LINKEDIN", true);
}

/**
 * Lightweight LinkedIn visit to read the company website link from About.
 * Default true even when full LinkedIn enrich is false.
 */
export function enrichLinkedInWebsite(): boolean {
  return envBool("LEAD_ENRICH_LINKEDIN_WEBSITE", true);
}

/**
 * Post-enrich ICP gate: require a website URL.
 * Default false so strong ICP companies without a discovered site are kept.
 * Tech-signals can set true when website intel is mandatory.
 */
export function requireWebsite(): boolean {
  return envBool("LEAD_REQUIRE_WEBSITE", false);
}

export function maxWebSearches(): number {
  return envInt("LEAD_MAX_WEB_SEARCHES", 10);
}

/** Prefer company website leadership/team pages for people (default true). */
export function peopleWebFirst(): boolean {
  return envBool("LEAD_PEOPLE_WEB_FIRST", true);
}

/**
 * Web search for LinkedIn `/in/` profiles (CEO/CTO/… keywords).
 * Off when LEAD_SKIP_WEB_SEARCH (default). Opt in with LEAD_PEOPLE_WEB_SEARCH=true
 * and LEAD_SKIP_WEB_SEARCH=false plus an API key or LEAD_HTML_SEARCH.
 */
export function peopleWebSearch(): boolean {
  return envBool("LEAD_PEOPLE_WEB_SEARCH", false) && !skipWebSearch();
}

/**
 * Master off switch for all web search (API + HTML SERP).
 * Default **true** — recommended path: LinkedIn About website → crawl site.
 * Set false only if you have Brave/Bing API keys or accept HTML CAPTCHA risk.
 */
export function skipWebSearch(): boolean {
  return envBool("LEAD_SKIP_WEB_SEARCH", true);
}

/**
 * Parallelism for **company website** visits only (different origins).
 * Search engines are always sequential. Never applied to LinkedIn.
 * Default 1; hard-capped at 2 (do not hammer search engines in parallel).
 */
export function webConcurrency(): number {
  return Math.max(1, Math.min(2, envInt("LEAD_WEB_CONCURRENCY", 1)));
}

/**
 * Prefer installed Google Chrome (`channel: 'chrome'`) for ephemeral web
 * browsers (not LinkedIn profile). Default true; falls back to Chromium.
 */
export function webUseSystemChrome(): boolean {
  return envBool("LEAD_WEB_USE_SYSTEM_CHROME", true);
}

/**
 * Extra delay multiplier for web search / SERP pacing (on top of
 * LI_SAFE_DELAY_MULT). Default 1.5 — raise to 2 after a CAPTCHA cool-down.
 */
export function webDelayMult(): number {
  const raw = process.env.LEAD_WEB_DELAY_MULT;
  if (raw === undefined || String(raw).trim() === "") return 1.5;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1.5;
}

/**
 * Filtered LinkedIn company employees (keywords + title filters).
 * Default true. Unfiltered People-tab scrape is not used.
 */
export function peopleLinkedInCompany(): boolean {
  return envBool("LEAD_PEOPLE_LINKEDIN_COMPANY", true);
}

/** Global LinkedIn people search — default **false** (use company People tab). */
export function peopleLinkedInSearch(): boolean {
  return envBool("LEAD_PEOPLE_LINKEDIN_SEARCH", false);
}

/** Lanatus-oriented defaults when LEAD_KEYWORDS is unset. */
export const DEFAULT_LEAD_KEYWORDS = [
  "software",
  "automation",
  "digital transformation",
  "IT consulting",
  "cloud",
  "custom software",
  "ERP",
  "legacy modernization",
];

/** Default industries that often buy IT consulting / custom build. */
export const DEFAULT_LEAD_INDUSTRIES = [
  "Manufacturing",
  "Logistics",
  "Healthcare",
  "Financial Services",
  "Professional Services",
  "Insurance",
  "Construction",
  "Energy",
  "Retail",
  "Education",
  "Transportation",
  "Wholesale",
];

/** Lanatus-oriented defaults when LEAD_GEOS is unset. */
export const DEFAULT_LEAD_GEOS = ["United States"];

export function leadKeywords(): string[] {
  return envList("LEAD_KEYWORDS", DEFAULT_LEAD_KEYWORDS);
}

export function leadIndustries(): string[] {
  return envList("LEAD_INDUSTRIES", DEFAULT_LEAD_INDUSTRIES);
}

export function leadGeos(): string[] {
  return envList("LEAD_GEOS", DEFAULT_LEAD_GEOS);
}

export function snapshotConfigFromEnv(): LeadRunConfigSnapshot {
  return {
    maxCompanies: envInt("LEAD_MAX_COMPANIES", 10),
    maxPeoplePerCompany: envInt("LEAD_MAX_PEOPLE_PER_COMPANY", 3),
    minScore: envInt("LEAD_MIN_SCORE", 60),
    keywords: leadKeywords(),
    geos: leadGeos(),
    industries: leadIndustries(),
    dryRun: isLeadDryRun(),
    offers: resolveOffers() as Record<string, string>,
  };
}
