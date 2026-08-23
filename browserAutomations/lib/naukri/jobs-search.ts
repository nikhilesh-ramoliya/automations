/**
 * Naukri job search: role × geo → scrape listing cards → optional keyword filter.
 */

import type { Page } from "playwright";
import { slugId, slugifyQuery } from "./io.js";
import {
  assertJobRuntime,
  assertWithinCap,
  naukriDelay,
  recordAction,
} from "./safety.js";
import { assertNotNaukriLogin } from "./browser.js";
import type { NaukriJob } from "./types.js";

export type JobCardLite = {
  title: string;
  companyName: string;
  jobUrl: string;
  location?: string;
  experience?: string;
  salary?: string;
  postedAgo?: string;
};

function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

/** Build a Naukri SERP URL for designation + location. */
export function naukriSearchUrl(role: string, geo: string): string {
  const roleSlug = slugifyQuery(role);
  const geoSlug = slugifyQuery(geo);
  // e.g. https://www.naukri.com/full-stack-developer-jobs-in-ahmedabad
  return `https://www.naukri.com/${roleSlug}-jobs-in-${geoSlug}`;
}

export async function scrapeJobCards(
  page: Page,
  max = 30,
): Promise<JobCardLite[]> {
  return (await page.evaluate(`((max) => {
    const out = [];
    const seen = new Set();

    const articles = Array.from(
      document.querySelectorAll(
        'article.jobTuple, div.srp-jobtuple-wrapper, div[data-job-id], article[data-job-id], .cust-job-tuple, .styles_jlc__main__VdwtF, .jobTupleHeader',
      ),
    );

    const cards =
      articles.length > 0
        ? articles
        : Array.from(document.querySelectorAll('a.title, a[href*="/job-listings-"]')).map(
            (a) => a.closest('article, div.srp-jobtuple-wrapper, li, div') || a.parentElement,
          );

    for (const card of cards) {
      if (!card) continue;
      const titleA =
        card.querySelector('a.title') ||
        card.querySelector('a[href*="/job-listings-"]') ||
        card.querySelector('a[href*="jobid="]');
      if (!titleA) continue;
      let href = (titleA.href || "").split("?")[0];
      if (!href || !/naukri\\.com/i.test(href)) continue;
      const key = href.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const title = (titleA.textContent || "").replace(/\\s+/g, " ").trim();
      if (!title || title.length < 2) continue;

      let companyName = "";
      const companyEl =
        card.querySelector("a.subTitle") ||
        card.querySelector(".comp-name") ||
        card.querySelector('[class*="comp-name"]') ||
        card.querySelector(".companyInfo a") ||
        card.querySelector("a[href*="/companies/"]");
      if (companyEl) {
        companyName = (companyEl.textContent || "").replace(/\\s+/g, " ").trim();
      }
      if (!companyName) {
        const sub = card.querySelector(".subTitle, .companyName, span.comp-name");
        companyName = ((sub && sub.textContent) || "Unknown").replace(/\\s+/g, " ").trim();
      }

      let location = undefined;
      const loc =
        card.querySelector(".locWdth") ||
        card.querySelector('[class*="loc"]') ||
        card.querySelector(".location") ||
        card.querySelector('span[title*="location" i]');
      if (loc) location = (loc.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);

      let experience = undefined;
      const exp =
        card.querySelector(".expwdth") ||
        card.querySelector('[class*="exp"]') ||
        card.querySelector(".experience");
      if (exp) experience = (exp.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);

      let salary = undefined;
      const sal =
        card.querySelector(".sal") ||
        card.querySelector('[class*="sal"]') ||
        card.querySelector(".salary");
      if (sal) salary = (sal.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);

      let postedAgo = undefined;
      const post =
        card.querySelector(".job-post-day") ||
        card.querySelector('[class*="job-post-day"]') ||
        card.querySelector(".postedDate");
      if (post) postedAgo = (post.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60);

      out.push({
        title: title.slice(0, 160),
        companyName: (companyName || "Unknown").slice(0, 120),
        jobUrl: href,
        location,
        experience,
        salary,
        postedAgo,
      });
      if (out.length >= max) break;
    }
    return out;
  })(${max})`)) as JobCardLite[];
}

/**
 * Open job detail for a short description snippet (for keyword filter).
 */
export async function readJobSnippet(page: Page, jobUrl: string): Promise<string> {
  assertWithinCap("page_view");
  const { gotoNaukriWithRetry } = await import("../auth-naukri.js");
  await gotoNaukriWithRetry(page, jobUrl, "job detail");
  await naukriDelay("nav");
  assertNotNaukriLogin(page, `job detail ${jobUrl}`);
  recordAction("page_view");

  const text = await page.evaluate(`(() => {
    const el =
      document.querySelector(".styles_job-desc-container__txpYf") ||
      document.querySelector(".job-desc") ||
      document.querySelector("#jobDescription") ||
      document.querySelector(".dang-inner-html") ||
      document.querySelector('[class*="job-desc"]') ||
      document.querySelector("section");
    return ((el && (el.innerText || el.textContent)) || "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 4000);
  })()`);
  return String(text || "");
}

export async function searchJobsForRoleGeo(
  page: Page,
  opts: {
    role: string;
    geo: string;
    keywords: string[];
    maxJobs: number;
    delayMs: number;
    collectedSoFar: number;
    /** When true, open each JD to filter keywords (slower). Default: filter on card text. */
    openDetails?: boolean;
  },
): Promise<NaukriJob[]> {
  assertJobRuntime();
  assertWithinCap("search");
  assertWithinCap("page_view");

  const { gotoNaukriWithRetry } = await import("../auth-naukri.js");
  const url = naukriSearchUrl(opts.role, opts.geo);
  await gotoNaukriWithRetry(page, url, `search ${opts.role} @ ${opts.geo}`);
  await naukriDelay("search", { minMs: opts.delayMs });
  assertNotNaukriLogin(page, `jobs search ${opts.role} ${opts.geo}`);
  recordAction("search");
  recordAction("page_view");

  // Dismiss login/chat overlays if any
  for (const sel of [
    'button:has-text("Got it")',
    ".crossIcon",
    '[class*="close"]',
  ]) {
    const b = page.locator(sel).first();
    if (await b.isVisible({ timeout: 600 }).catch(() => false)) {
      await b.click().catch(() => undefined);
    }
  }

  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 900 + Math.floor(Math.random() * 400));
    await naukriDelay("read_card");
  }

  const remaining = Math.max(0, opts.maxJobs - opts.collectedSoFar);
  if (remaining === 0) return [];

  const cards = await scrapeJobCards(page, Math.min(40, remaining * 2));
  console.log(
    `  Naukri SERP: ${opts.role} @ ${opts.geo} → ${cards.length} cards`,
  );

  const now = new Date().toISOString();
  const matched: NaukriJob[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    if (matched.length >= remaining) break;
    const key = card.jobUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let snippet = [card.title, card.companyName, card.location, card.experience]
      .filter(Boolean)
      .join(" ");
    let hits = matchKeywords(snippet, opts.keywords);

    if (opts.openDetails && hits.length === 0) {
      try {
        const desc = await readJobSnippet(page, card.jobUrl);
        snippet = `${snippet} ${desc}`;
        hits = matchKeywords(snippet, opts.keywords);
        await naukriDelay("between");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`    detail failed: ${msg}`);
        if (/login/i.test(msg)) throw err;
      }
    }

    // If keywords configured, require at least one hit; if empty list, keep all
    if (opts.keywords.length > 0 && hits.length === 0) {
      console.log(`    skip (no keywords): ${card.title}`);
      continue;
    }

    const id = slugId(
      "nk",
      `${card.companyName}-${card.title}-${card.jobUrl.slice(-24)}`,
    );
    matched.push({
      id,
      title: card.title,
      companyName: card.companyName,
      location: card.location,
      experience: card.experience,
      salary: card.salary,
      jobUrl: card.jobUrl,
      postedAgo: card.postedAgo,
      keywordsMatched: hits,
      roleQuery: opts.role,
      geo: opts.geo,
      descriptionSnippet: snippet.slice(0, 300),
      discoveredAt: now,
    });
    console.log(`    keep: ${card.title} @ ${card.companyName}`);
  }

  return matched;
}

export async function searchAllJobs(
  page: Page,
  opts: {
    roles: string[];
    geos: string[];
    keywords: string[];
    maxJobs: number;
    delayMs: number;
    openDetails?: boolean;
  },
): Promise<NaukriJob[]> {
  const all: NaukriJob[] = [];
  const seen = new Set<string>();

  for (const role of opts.roles) {
    for (const geo of opts.geos) {
      if (all.length >= opts.maxJobs) break;
      console.log(`\nSearching Naukri: "${role}" in ${geo}…`);
      const batch = await searchJobsForRoleGeo(page, {
        role,
        geo,
        keywords: opts.keywords,
        maxJobs: opts.maxJobs,
        delayMs: opts.delayMs,
        collectedSoFar: all.length,
        openDetails: opts.openDetails,
      });
      for (const job of batch) {
        const key = job.jobUrl.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(job);
        if (all.length >= opts.maxJobs) break;
      }
      await naukriDelay("between");
    }
    if (all.length >= opts.maxJobs) break;
  }
  return all;
}
