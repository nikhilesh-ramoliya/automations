/**
 * LinkedIn Jobs search: role × geo → open JD → keep if description matches keywords.
 */

import type { Page } from "playwright";
import {
  assertJobRuntime,
  assertWithinCap,
  humanDelay,
  recordAction,
} from "../linkedin-safety.js";
import { assertNotLogin } from "../leads/browser.js";
import { normalizeLinkedInUrl, slugId } from "./io.js";
import type { JobPosting } from "./types.js";

export type JobCardLite = {
  title: string;
  companyName: string;
  jobUrl: string;
  location?: string;
  companyLinkedInUrl?: string;
};

function matchKeywords(
  text: string,
  keywords: string[],
): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

function jobsSearchUrl(role: string, geo: string): string {
  const u = new URL("https://www.linkedin.com/jobs/search/");
  u.searchParams.set("keywords", role);
  u.searchParams.set("location", geo);
  u.searchParams.set("f_TPR", "r604800"); // past week — fresher roles
  return u.href;
}

/** Scrape visible job cards from the current Jobs SERP (left list). */
export async function scrapeJobCards(
  page: Page,
  max = 20,
): Promise<JobCardLite[]> {
  return (await page.evaluate(`((max) => {
    const out = [];
    const seen = new Set();
    const anchors = Array.from(
      document.querySelectorAll(
        'a.job-card-list__title--link, a.job-card-container__link, a[href*="/jobs/view/"]',
      ),
    );
    for (const a of anchors) {
      let href = (a.href || "").split("?")[0];
      if (!/\\/jobs\\/view\\/\\d+/i.test(href)) continue;
      const key = href.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const card =
        a.closest("li") ||
        a.closest(".job-card-container") ||
        a.closest(".jobs-search-results__list-item") ||
        a.parentElement;

      let title = (a.textContent || "").replace(/\\s+/g, " ").trim();
      if (!title || title.length < 2) {
        const t = card && card.querySelector(
          ".job-card-list__title, .artdeco-entity-lockup__title, strong",
        );
        title = ((t && t.textContent) || "").replace(/\\s+/g, " ").trim();
      }
      if (!title) continue;

      let companyName = "";
      const companyEl = card && card.querySelector(
        ".job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .job-card-list__company-name, h4",
      );
      if (companyEl) {
        companyName = (companyEl.textContent || "").replace(/\\s+/g, " ").trim();
      }

      let location = undefined;
      const locEl = card && card.querySelector(
        ".job-card-container__metadata-item, .job-card-list__footer-wrapper li, .artdeco-entity-lockup__caption",
      );
      if (locEl) {
        location = (locEl.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      }

      let companyLinkedInUrl = undefined;
      const companyA = card && card.querySelector('a[href*="/company/"]');
      if (companyA && companyA.href) {
        companyLinkedInUrl = companyA.href.split("?")[0].replace(/\\/$/, "") + "/";
      }

      out.push({
        title: title.slice(0, 160),
        companyName: (companyName || "Unknown").slice(0, 120),
        jobUrl: href,
        location,
        companyLinkedInUrl,
      });
      if (out.length >= max) break;
    }
    return out;
  })(${max})`)) as JobCardLite[];
}

/** Open a job view and extract description + company link. */
export async function readJobDetail(
  page: Page,
  jobUrl: string,
): Promise<{
  description: string;
  companyName?: string;
  companyLinkedInUrl?: string;
  title?: string;
  location?: string;
}> {
  assertWithinCap("page_view");
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay("nav");
  assertNotLogin(page, `job detail ${jobUrl}`);
  recordAction("page_view");

  // Expand "Show more" on description when present
  const showMore = page
    .locator(
      'button:has-text("Show more"), button.jobs-description__footer-button, button[aria-label*="Show more" i]',
    )
    .first();
  if (await showMore.isVisible({ timeout: 1500 }).catch(() => false)) {
    await humanDelay("click");
    await showMore.click().catch(() => undefined);
    await humanDelay("read_card", { minMs: 400, maxMs: 900 });
  }

  await page.mouse.wheel(0, 600);
  await humanDelay("read_card", { minMs: 500, maxMs: 1200 });

  return (await page.evaluate(`(() => {
    const desc =
      document.querySelector(".jobs-description__content") ||
      document.querySelector("#job-details") ||
      document.querySelector(".jobs-box__html-content") ||
      document.querySelector(".description__text") ||
      document.querySelector("article");
    const description = (desc?.innerText || desc?.textContent || "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 12000);

    let title = undefined;
    const titleEl =
      document.querySelector(".job-details-jobs-unified-top-card__job-title") ||
      document.querySelector("h1");
    if (titleEl) title = (titleEl.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160);

    let companyName = undefined;
    let companyLinkedInUrl = undefined;
    const companyA =
      document.querySelector(
        '.job-details-jobs-unified-top-card__company-name a[href*="/company/"]',
      ) ||
      document.querySelector('a.topcard__org-name-link') ||
      document.querySelector('.jobs-unified-top-card__company-name a[href*="/company/"]');
    if (companyA) {
      companyName = (companyA.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      companyLinkedInUrl =
        (companyA.href || "").split("?")[0].replace(/\\/$/, "") + "/";
    }

    let location = undefined;
    const locEl =
      document.querySelector(".job-details-jobs-unified-top-card__bullet") ||
      document.querySelector(".jobs-unified-top-card__bullet") ||
      document.querySelector(".topcard__flavor--bullet");
    if (locEl) {
      location = (locEl.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    }

    return { description, companyName, companyLinkedInUrl, title, location };
  })()`)) as {
    description: string;
    companyName?: string;
    companyLinkedInUrl?: string;
    title?: string;
    location?: string;
  };
}

/**
 * Search LinkedIn Jobs for one role×geo, open details, keep keyword matches.
 */
export async function searchJobsForRoleGeo(
  page: Page,
  opts: {
    role: string;
    geo: string;
    jdKeywords: string[];
    maxJobs: number;
    delayMs: number;
    /** Already collected — stop when total reaches maxJobs */
    collectedSoFar: number;
  },
): Promise<JobPosting[]> {
  assertJobRuntime();
  assertWithinCap("search");
  assertWithinCap("page_view");

  const url = jobsSearchUrl(opts.role, opts.geo);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay("search", { minMs: opts.delayMs });
  assertNotLogin(page, `jobs search ${opts.role} ${opts.geo}`);
  recordAction("search");
  recordAction("page_view");

  // Load a few more cards
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 800 + Math.floor(Math.random() * 400));
    await humanDelay("read_card", { minMs: 700, maxMs: 1500 });
  }

  const remaining = Math.max(0, opts.maxJobs - opts.collectedSoFar);
  if (remaining === 0) return [];

  const cards = await scrapeJobCards(page, Math.min(15, remaining * 2));
  console.log(
    `  Jobs SERP: ${opts.role} @ ${opts.geo} → ${cards.length} cards`,
  );

  const now = new Date().toISOString();
  const matched: JobPosting[] = [];
  const seenUrls = new Set<string>();

  for (const card of cards) {
    if (matched.length >= remaining) break;
    const normUrl = normalizeLinkedInUrl(card.jobUrl) ?? card.jobUrl;
    if (seenUrls.has(normUrl)) continue;
    seenUrls.add(normUrl);

    try {
      const detail = await readJobDetail(page, card.jobUrl);
      const blob = [
        detail.title ?? card.title,
        detail.companyName ?? card.companyName,
        detail.description,
      ].join("\n");
      const hits = matchKeywords(blob, opts.jdKeywords);
      if (hits.length === 0) {
        console.log(`    skip (no JD keywords): ${card.title}`);
        await humanDelay("between_companies", { minMs: 800, maxMs: 1800 });
        continue;
      }

      const title = detail.title || card.title;
      const companyName = detail.companyName || card.companyName;
      const companyLinkedInUrl = normalizeLinkedInUrl(
        detail.companyLinkedInUrl || card.companyLinkedInUrl,
      );
      const jobNum = normUrl.match(/\/(\d+)\/?$/)?.[1] ?? String(matched.length);
      const id = slugId("job", `${companyName}-${title}-${jobNum}`);

      matched.push({
        id,
        title,
        companyName,
        companyLinkedInUrl,
        jobUrl: normalizeLinkedInUrl(card.jobUrl) ?? card.jobUrl,
        location: detail.location || card.location,
        geo: opts.geo,
        roleQuery: opts.role,
        descriptionSnippet: (detail.description || "").slice(0, 400),
        matchedKeywords: hits,
        discoveredAt: now,
      });
      console.log(
        `    keep: ${title} @ ${companyName} [${hits.slice(0, 3).join(", ")}]`,
      );
      await humanDelay("between_companies");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`    job detail failed: ${msg}`);
      if (/login|checkpoint|restriction/i.test(msg)) throw err;
    }
  }

  return matched;
}

/**
 * Run all role×geo combinations until maxJobs is reached (dedupe by job URL).
 */
export async function searchAllJobs(
  page: Page,
  opts: {
    roles: string[];
    geos: string[];
    jdKeywords: string[];
    maxJobs: number;
    delayMs: number;
  },
): Promise<JobPosting[]> {
  const all: JobPosting[] = [];
  const seen = new Set<string>();

  for (const role of opts.roles) {
    for (const geo of opts.geos) {
      if (all.length >= opts.maxJobs) break;
      console.log(`\nSearching jobs: "${role}" in ${geo}…`);
      const batch = await searchJobsForRoleGeo(page, {
        role,
        geo,
        jdKeywords: opts.jdKeywords,
        maxJobs: opts.maxJobs,
        delayMs: opts.delayMs,
        collectedSoFar: all.length,
      });
      for (const job of batch) {
        const key = (normalizeLinkedInUrl(job.jobUrl) ?? job.jobUrl).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(job);
        if (all.length >= opts.maxJobs) break;
      }
      await humanDelay("between_companies");
    }
    if (all.length >= opts.maxJobs) break;
  }

  return all;
}
