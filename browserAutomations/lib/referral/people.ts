/**
 * Find recruiters first, then peer developers, at companies with matching jobs.
 */

import type { Page } from "playwright";
import {
  assertJobRuntime,
  assertWithinCap,
  humanDelay,
  recordAction,
} from "../linkedin-safety.js";
import { assertNotLogin } from "../leads/browser.js";
import {
  humanPeopleSearch,
  scrapePeopleFromSerp,
} from "../visibility/people-search-ui.js";
import {
  normalizeCompanyName,
  normalizeLinkedInUrl,
  slugId,
} from "./io.js";
import type { JobPosting, ReferralPerson, ReferralPersonKind } from "./types.js";

export const RECRUITER_TITLE_RE =
  /\b(recruiter|talent\s*acquisition|talent\s*partner|hiring\s*manager|sourcer|people\s*ops|human\s*resources|\bHR\b|staffing)\b/i;

export const PEER_TITLE_RE =
  /\b(full\s*stack|mern|react|frontend|front[\s-]?end|software\s*engineer|software\s*developer|web\s*developer|javascript|typescript|node\.?js)\b/i;

const RECRUITER_QUERY = "recruiter OR talent OR hiring";
const PEER_QUERY = "full stack OR react OR MERN OR software engineer";

function companyPeopleUrl(linkedinUrl: string, keywords?: string): string {
  const base = linkedinUrl.replace(/\/$/, "");
  const peopleBase = /\/people\/?/i.test(base) ? `${base}/` : `${base}/people/`;
  if (!keywords) return peopleBase;
  const u = new URL(peopleBase);
  u.searchParams.set("keywords", keywords);
  return u.href;
}

type RawPerson = {
  name: string;
  title?: string;
  linkedinUrl: string;
};

async function scrapeCompanyPeopleCards(
  page: Page,
  max = 25,
): Promise<RawPerson[]> {
  return (await page.evaluate(`((max) => {
    const out = [];
    const seen = new Set();
    const NOISE = /\\b(\\d+(st|nd|rd|th)\\+?\\s*degree|degree\\s+connection|follows?\\s+this\\s+page|followers?|mutual\\s+connection)\\b/i;

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
      if (!name || NOISE.test(name)) continue;

      const text = ((card && card.textContent) || "").replace(/\\s+/g, " ").trim();
      let title = "";
      const sub = card && card.querySelector(
        ".artdeco-entity-lockup__subtitle, .entity-result__primary-subtitle, .org-people-profile-card__profile-title, .t-14.t-black--light",
      );
      if (sub) {
        title = (sub.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      }
      if (!title || NOISE.test(title) || title.length < 3) {
        const parts = text.replace(name, "").trim();
        const candidate = parts.split(/\\s{2,}|·/)[0]?.trim().slice(0, 120) || "";
        title = NOISE.test(candidate) ? "" : candidate;
      }
      if (!title || NOISE.test(title)) continue;

      seen.add(slug);
      out.push({
        name: name.slice(0, 100),
        title: title.slice(0, 120),
        linkedinUrl: "https://www.linkedin.com/in/" + slug + "/",
      });
      if (out.length >= max) break;
    }
    return out;
  })(${max})`)) as RawPerson[];
}

async function discoverFromCompanyPeople(
  page: Page,
  companyLinkedInUrl: string,
  companyName: string,
  keywords: string,
  kind: ReferralPersonKind,
  titleRe: RegExp,
  max: number,
  delayMs: number,
): Promise<ReferralPerson[]> {
  if (max <= 0) return [];

  assertJobRuntime();
  assertWithinCap("page_view");

  const peopleUrl = companyPeopleUrl(companyLinkedInUrl, keywords);
  await page.goto(peopleUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay("read_profile");
  assertNotLogin(page, `company people ${companyName}`);
  recordAction("page_view");

  if (!/\/people/i.test(page.url())) {
    await page.goto(companyLinkedInUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await humanDelay("nav", { minMs: 800 });
    recordAction("page_view");
    await page.goto(peopleUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await humanDelay("read_profile");
    assertNotLogin(page, `company people keywords ${companyName}`);
    recordAction("page_view");
  }

  const peopleSearch = page
    .locator(
      'input[placeholder*="Search by title" i], input[placeholder*="search" i][aria-label*="people" i], input.org-people__search-input, input[name="keywords"]',
    )
    .first();
  if (await peopleSearch.isVisible({ timeout: 2000 }).catch(() => false)) {
    await humanDelay("click");
    await peopleSearch.fill(keywords).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await humanDelay("search", { minMs: Math.min(delayMs, 3000) });
  }

  await page.mouse.wheel(0, 1000);
  await humanDelay("read_card", { minMs: 500 });

  const raw = await scrapeCompanyPeopleCards(page, 30);
  const now = new Date().toISOString();
  const out: ReferralPerson[] = [];

  for (const p of raw) {
    if (out.length >= max) break;
    if (!p.title || !titleRe.test(p.title)) continue;
    const url = normalizeLinkedInUrl(p.linkedinUrl);
    if (!url) continue;
    out.push({
      id: slugId("person", `${p.name}-${url}`),
      name: p.name,
      title: p.title,
      linkedinUrl: url,
      companyName,
      companyLinkedInUrl: normalizeLinkedInUrl(companyLinkedInUrl),
      kind,
      source: "company_people",
      discoveredAt: now,
    });
  }
  return out;
}

async function discoverFromPeopleSearch(
  page: Page,
  companyName: string,
  queryExtra: string,
  kind: ReferralPersonKind,
  titleRe: RegExp,
  max: number,
  delayMs: number,
  companyLinkedInUrl?: string,
): Promise<ReferralPerson[]> {
  if (max <= 0) return [];

  const query = `${queryExtra} ${companyName}`.trim();
  await humanPeopleSearch(page, query, delayMs);
  const cards = await scrapePeopleFromSerp(page, 20);
  const companyNorm = normalizeCompanyName(companyName);
  const now = new Date().toISOString();
  const out: ReferralPerson[] = [];

  for (const c of cards) {
    if (out.length >= max) break;
    const title = c.title || "";
    if (!titleRe.test(title)) continue;
    // Prefer cards that mention the company in title/location text
    const hay = `${c.name} ${title} ${c.location ?? ""}`.toLowerCase();
    if (
      companyNorm &&
      !hay.includes(companyNorm.split(" ")[0]!) &&
      !normalizeCompanyName(title).includes(companyNorm.split(" ")[0]!)
    ) {
      // Still allow if title matches strongly (recruiter at company often shows company in subtitle)
      if (!/at\s+/i.test(title) && kind === "peer") continue;
    }
    const url = normalizeLinkedInUrl(c.profileUrl);
    if (!url) continue;
    out.push({
      id: slugId("person", `${c.name}-${url}`),
      name: c.name,
      title: title || undefined,
      linkedinUrl: url,
      companyName,
      companyLinkedInUrl: normalizeLinkedInUrl(companyLinkedInUrl),
      kind,
      source: "people_search",
      discoveredAt: now,
    });
  }
  return out;
}

export type CompanyBucket = {
  companyName: string;
  companyLinkedInUrl?: string;
  jobIds: string[];
  geos: string[];
};

export function companiesFromJobs(jobs: JobPosting[]): CompanyBucket[] {
  const map = new Map<string, CompanyBucket>();
  for (const job of jobs) {
    const key =
      normalizeLinkedInUrl(job.companyLinkedInUrl) ||
      normalizeCompanyName(job.companyName) ||
      job.companyName.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      if (!existing.jobIds.includes(job.id)) existing.jobIds.push(job.id);
      if (!existing.geos.includes(job.geo)) existing.geos.push(job.geo);
      if (!existing.companyLinkedInUrl && job.companyLinkedInUrl) {
        existing.companyLinkedInUrl = job.companyLinkedInUrl;
      }
    } else {
      map.set(key, {
        companyName: job.companyName,
        companyLinkedInUrl: job.companyLinkedInUrl,
        jobIds: [job.id],
        geos: [job.geo],
      });
    }
  }
  return [...map.values()];
}

/**
 * For one company: recruiters first (up to maxRecruiters), then peers to fill maxTotal.
 */
export async function findPeopleForCompany(
  page: Page,
  company: CompanyBucket,
  opts: {
    maxTotal: number;
    maxRecruiters: number;
    delayMs: number;
  },
): Promise<ReferralPerson[]> {
  const { maxTotal, maxRecruiters, delayMs } = opts;
  const found: ReferralPerson[] = [];
  const seenUrls = new Set<string>();

  const add = (people: ReferralPerson[]) => {
    for (const p of people) {
      const key = p.linkedinUrl.toLowerCase();
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      found.push(p);
      if (found.length >= maxTotal) break;
    }
  };

  const needRecruiters = Math.min(maxRecruiters, maxTotal);
  if (company.companyLinkedInUrl) {
    console.log(
      `  Company people (recruiters): ${company.companyName}`,
    );
    add(
      await discoverFromCompanyPeople(
        page,
        company.companyLinkedInUrl,
        company.companyName,
        RECRUITER_QUERY,
        "recruiter",
        RECRUITER_TITLE_RE,
        needRecruiters,
        delayMs,
      ),
    );
  }

  if (found.filter((p) => p.kind === "recruiter").length < needRecruiters) {
    const stillNeed =
      needRecruiters - found.filter((p) => p.kind === "recruiter").length;
    console.log(`  People search (recruiters): ${company.companyName}`);
    add(
      await discoverFromPeopleSearch(
        page,
        company.companyName,
        "recruiter talent hiring",
        "recruiter",
        RECRUITER_TITLE_RE,
        stillNeed,
        delayMs,
        company.companyLinkedInUrl,
      ),
    );
  }

  const peerSlots = maxTotal - found.length;
  if (peerSlots > 0 && company.companyLinkedInUrl) {
    console.log(`  Company people (peers): ${company.companyName}`);
    add(
      await discoverFromCompanyPeople(
        page,
        company.companyLinkedInUrl,
        company.companyName,
        PEER_QUERY,
        "peer",
        PEER_TITLE_RE,
        peerSlots,
        delayMs,
      ),
    );
  }

  if (found.length < maxTotal) {
    const still = maxTotal - found.length;
    console.log(`  People search (peers): ${company.companyName}`);
    add(
      await discoverFromPeopleSearch(
        page,
        company.companyName,
        "full stack react software engineer",
        "peer",
        PEER_TITLE_RE,
        still,
        delayMs,
        company.companyLinkedInUrl,
      ),
    );
  }

  return found.slice(0, maxTotal);
}
