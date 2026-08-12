/**
 * Single LinkedIn company-page session harvest:
 * Home → About (website) → People (local title search) → Posts (tech/buying signals).
 */

import type { Page } from "playwright";
import { humanBrowseProfile, humanScroll } from "../human-browse.js";
import {
  assertJobRuntime,
  assertWithinCap,
  humanDelay,
  recordAction,
} from "../linkedin-safety.js";
import { assertNotLogin } from "./browser.js";
import {
  type DiscoveredPerson,
  isValidDecisionMaker,
  rankAndCapPeople,
  scoreDecisionTitle,
} from "./people-discovery.js";
import type { CompanyRecord, TechSignals } from "./types.js";

const PEOPLE_TITLE_QUERIES = [
  "CEO",
  "CTO",
  "Founder",
  "CIO",
  "VP Engineering",
  "Head of IT",
  "Director",
];

const TECH_TERMS = [
  "aws",
  "azure",
  "gcp",
  "cloud",
  "devops",
  "kubernetes",
  "saas",
  "erp",
  "crm",
  "salesforce",
  "sap",
  "oracle",
  "automation",
  "rpa",
  "ai",
  "machine learning",
  "digital transformation",
  "legacy",
  "modernization",
  "api",
  "microservices",
  "software",
  "platform",
  "hiring",
  "we're hiring",
  "open roles",
];

export type LinkedInHarvestResult = {
  companyId: string;
  companyName: string;
  linkedinUrl?: string;
  websiteUrl?: string;
  about?: string;
  industry?: string;
  employeeCount?: string;
  location?: string;
  tagline?: string;
  people: DiscoveredPerson[];
  postSnippets: string[];
  postKeywords: string[];
  buyingHints: string[];
  careersMentionsHiring?: boolean;
  harvestedAt: string;
  notes: string[];
};

function companySlugUrl(linkedinUrl: string): string {
  return linkedinUrl.replace(/\/$/, "").split("?")[0]!;
}

function aboutUrl(linkedinUrl: string): string {
  const base = companySlugUrl(linkedinUrl);
  if (/\/about\/?$/i.test(base)) return `${base}/`;
  return `${base}/about/`;
}

function peopleUrl(linkedinUrl: string, keywords?: string): string {
  const base = companySlugUrl(linkedinUrl);
  const peopleBase = /\/people\/?/i.test(base)
    ? `${base.replace(/\/people\/?$/i, "")}/people/`
    : `${base}/people/`;
  if (!keywords) return peopleBase;
  const u = new URL(peopleBase);
  u.searchParams.set("keywords", keywords);
  return u.href;
}

function postsUrl(linkedinUrl: string): string {
  const base = companySlugUrl(linkedinUrl);
  if (/\/posts\/?/i.test(base)) return `${base}/`;
  return `${base}/posts/?feedView=all`;
}

async function clickAboutTab(page: Page): Promise<boolean> {
  const candidates = [
    page.getByRole("link", { name: /^About$/i }),
    page.locator('a[href*="/about"]').filter({ hasText: /^About$/i }),
    page.locator('button:has-text("About"), [aria-label="About"]'),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      await humanDelay("click");
      await el.click({ timeout: 5000 }).catch(() => undefined);
      await humanDelay("nav");
      return true;
    }
  }
  return false;
}

async function extractAboutPanel(page: Page): Promise<{
  website?: string;
  about?: string;
  industry?: string;
  employeeCount?: string;
  location?: string;
  tagline?: string;
}> {
  return (await page.evaluate(`(() => {
    const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
    const body = clean(document.body && document.body.innerText
      ? document.body.innerText.slice(0, 12000)
      : "");

    // Prefer About module text (not global chrome)
    const aboutEl =
      document.querySelector('[data-test-id="about-us__description"]') ||
      document.querySelector('[data-test-id="about-us"]') ||
      document.querySelector(".org-about-module") ||
      document.querySelector(".org-page-details-module") ||
      document.querySelector("section.org-about-company-module") ||
      document.querySelector("section.about-us");
    let about = clean(aboutEl && aboutEl.textContent).slice(0, 1500);

    // Structured dl / definition list for Website
    let website = "";
    const rows = Array.from(
      document.querySelectorAll(
        "dt, .org-page-details-module__card-spacing dt, [data-test-id*='about'] dt, .text-body-medium",
      ),
    );
    for (const dt of rows) {
      const label = clean(dt.textContent).toLowerCase();
      if (!/^website$|^company website$|^site$/i.test(label) && label !== "website") {
        if (!/^website\\b/i.test(label)) continue;
      }
      const dd =
        dt.nextElementSibling ||
        dt.parentElement?.querySelector("dd, a[href]");
      const a =
        (dd && dd.querySelector && dd.querySelector("a[href]")) ||
        (dd && dd.tagName === "A" ? dd : null) ||
        dt.parentElement?.querySelector("a[href]");
      if (a) {
        const href = a.getAttribute("href") || "";
        try {
          const u = new URL(href, location.href);
          if (!u.hostname.includes("linkedin.com")) {
            website = u.href;
            break;
          }
          const out = u.searchParams.get("url");
          if (out) {
            website = decodeURIComponent(out);
            break;
          }
        } catch {}
      }
      const t = clean(dd && dd.textContent);
      if (/^https?:\\/\\//i.test(t) && !/linkedin\\.com/i.test(t)) {
        website = t;
        break;
      }
    }

    if (!website) {
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") || "";
        const label = clean(
          (a.textContent || "") + " " + (a.getAttribute("aria-label") || ""),
        ).toLowerCase();
        const parent = clean(
          a.closest("section, li, div, dd, dt")?.textContent || "",
        ).toLowerCase();
        const nearWebsite =
          /\\bwebsite\\b|visit website|company website|our website/i.test(
            label + " " + parent.slice(0, 80),
          );
        if (!nearWebsite && !/website/i.test(label)) continue;
        try {
          const u = new URL(href, location.href);
          if (!u.hostname.includes("linkedin.com")) {
            website = u.href;
            break;
          }
          const out = u.searchParams.get("url");
          if (out) {
            const decoded = decodeURIComponent(out);
            if (/^https?:/i.test(decoded) && !/linkedin\\.com/i.test(decoded)) {
              website = decoded;
              break;
            }
          }
        } catch {}
      }
    }

    // Last resort: any external redirect link in About section
    if (!website && aboutEl) {
      for (const a of Array.from(aboutEl.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") || "";
        try {
          const u = new URL(href, location.href);
          if (!u.hostname.includes("linkedin.com")) {
            website = u.href;
            break;
          }
          const out = u.searchParams.get("url");
          if (out) {
            const decoded = decodeURIComponent(out);
            if (!/linkedin\\.com|facebook\\.com|twitter\\.com/i.test(decoded)) {
              website = decoded;
              break;
            }
          }
        } catch {}
      }
    }

    if (!about) {
      const m = body.match(/Overview\\s+(.{80,800}?)(?:\\s+Website\\b|\\s+Industry\\b|\\s+Company size\\b)/i);
      if (m) about = clean(m[1]).slice(0, 1200);
    }

    const industryMatch = body.match(/Industry\\s+([^\\n]+?)(?:\\s+Company size|\\s+Headquarters|\\s+Specialties|$)/i);
    const sizeMatch = body.match(/Company size\\s+([^\\n]+?)(?:\\s+Associated|\\s+Headquarters|\\s+Specialties|$)/i);
    const locMatch = body.match(/Headquarters\\s+([^\\n]+?)(?:\\s+Specialties|\\s+Founded|$)/i);
    const taglineEl = document.querySelector(
      ".org-top-card-summary__tagline, .org-top-card__tagline, h1 + div",
    );
    let tagline = clean(taglineEl && taglineEl.textContent).slice(0, 200);
    if (!tagline || /notification|skip to|keyboard shortcut/i.test(tagline)) {
      tagline = "";
    }

    return {
      website: website || undefined,
      about: about || undefined,
      industry: industryMatch ? clean(industryMatch[1]).slice(0, 120) : undefined,
      employeeCount: sizeMatch ? clean(sizeMatch[1]).slice(0, 80) : undefined,
      location: locMatch ? clean(locMatch[1]).slice(0, 120) : undefined,
      tagline: tagline || undefined,
    };
  })()`)) as {
    website?: string;
    about?: string;
    industry?: string;
    employeeCount?: string;
    location?: string;
    tagline?: string;
  };
}

async function scrapePeopleOnCompanyPage(
  page: Page,
  maxPeople: number,
): Promise<DiscoveredPerson[]> {
  await page.mouse.wheel(0, 1400);
  await humanDelay("read_card", { minMs: 500 });

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
      let title = "";
      const sub = card && card.querySelector(
        ".artdeco-entity-lockup__subtitle, .entity-result__primary-subtitle, .org-people-profile-card__profile-title, .t-14.t-black--light",
      );
      if (sub) title = (sub.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
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
      if (out.length >= 40) break;
    }
    return out;
  })()`)) as Array<{ name: string; title?: string; linkedinUrl?: string }>;

  return rankAndCapPeople(
    raw
      .filter((p) =>
        isValidDecisionMaker(p.name, p.title, { requireCaps: false }),
      )
      .map((p) => ({
        name: p.name,
        title: p.title,
        linkedinUrl: p.linkedinUrl,
        source: "linkedin_company" as const,
        rankScore: scoreDecisionTitle(p.title),
      })),
    maxPeople,
  );
}

async function localPeopleSearch(
  page: Page,
  companyLinkedInUrl: string,
  maxPeople: number,
  delayMs: number,
): Promise<DiscoveredPerson[]> {
  const collected: DiscoveredPerson[] = [];
  const seen = new Set<string>();

  // Open People tab (base, then search locally)
  assertWithinCap("page_view");
  await page.goto(peopleUrl(companyLinkedInUrl), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanBrowseProfile(page);
  assertNotLogin(page, "company people");
  recordAction("page_view");

  // Click People nav if URL didn't land there
  if (!/\/people/i.test(page.url())) {
    const peopleNav = page
      .getByRole("link", { name: /^People$/i })
      .or(page.locator('a[href*="/people"]').filter({ hasText: /^People$/i }))
      .first();
    if (await peopleNav.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanDelay("click");
      await peopleNav.click().catch(() => undefined);
      await humanDelay("nav");
    }
  }

  const peopleSearch = page
    .locator(
      'input[placeholder*="Search by title" i], input[placeholder*="title" i], input.org-people__search-input, input[aria-label*="Search by title" i], input[name="keywords"]',
    )
    .first();

  for (const q of PEOPLE_TITLE_QUERIES) {
    if (collected.length >= maxPeople) break;
    assertJobRuntime();
    assertWithinCap("search");

    if (await peopleSearch.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanDelay("click");
      await peopleSearch.fill("").catch(() => undefined);
      await peopleSearch.fill(q).catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
      recordAction("search");
      await humanDelay("search", { minMs: Math.min(delayMs, 3000) });
    } else {
      // Fallback: keywords in URL (still company People scope)
      assertWithinCap("page_view");
      await page.goto(peopleUrl(companyLinkedInUrl, q), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await humanDelay("search", { minMs: Math.min(delayMs, 3000) });
      recordAction("page_view");
      recordAction("search");
    }

    const batch = await scrapePeopleOnCompanyPage(page, maxPeople);
    for (const p of batch) {
      const key = (p.linkedinUrl || p.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(p);
    }
  }

  return rankAndCapPeople(collected, maxPeople);
}

async function scrapeRecentPosts(
  page: Page,
  companyLinkedInUrl: string,
  delayMs: number,
): Promise<{
  snippets: string[];
  keywords: string[];
  buyingHints: string[];
  careersMentionsHiring: boolean;
}> {
  assertWithinCap("page_view");
  await page.goto(postsUrl(companyLinkedInUrl), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanBrowseProfile(page);
  assertNotLogin(page, "company posts");
  recordAction("page_view");

  // Fallback to home feed if posts URL empty
  if (!/\/(posts|recent-activity)/i.test(page.url())) {
    await page.goto(companySlugUrl(companyLinkedInUrl), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await humanDelay("nav");
    recordAction("page_view");
  }

  await humanScroll(page, { passes: 2, allowUp: true });
  await humanDelay("read_card");
  await humanScroll(page, { passes: 1 });
  await humanDelay("read_card");

  const snippets = (await page.evaluate(`(() => {
    const out = [];
    const nodes = Array.from(
      document.querySelectorAll(
        ".feed-shared-update-v2, .occludable-update, article, [data-urn*='activity']",
      ),
    );
    for (const n of nodes) {
      const t = (n.textContent || "").replace(/\\s+/g, " ").trim();
      if (t.length < 40) continue;
      // Skip nav chrome
      if (/Skip to search|Keyboard shortcuts|My Network/i.test(t.slice(0, 80))) {
        continue;
      }
      out.push(t.slice(0, 400));
      if (out.length >= 8) break;
    }
    if (out.length === 0) {
      const body = (document.body && document.body.innerText
        ? document.body.innerText
        : ""
      ).replace(/\\s+/g, " ");
      const m = body.match(/(?:followers|employees).{0,40}(.{100,500})/i);
      if (m) out.push(m[1].slice(0, 400));
    }
    return out;
  })()`)) as string[];

  const blob = snippets.join(" ").toLowerCase();
  const keywords = TECH_TERMS.filter((t) => blob.includes(t.toLowerCase()));
  const buyingHints: string[] = [];
  if (/hiring|we.?re hiring|join our team|open role/i.test(blob)) {
    buyingHints.push("linkedin_posts_hiring");
  }
  if (/digital transformation|moderniz|legacy|automat|cloud migrat/i.test(blob)) {
    buyingHints.push("linkedin_posts_transformation");
  }
  if (/launch|product|platform|saas/i.test(blob)) {
    buyingHints.push("linkedin_posts_product");
  }

  return {
    snippets: snippets.slice(0, 5),
    keywords: [...new Set(keywords)],
    buyingHints,
    careersMentionsHiring: buyingHints.includes("linkedin_posts_hiring"),
  };
}

/**
 * One company, one LinkedIn tab flow: About → People (local search) → Posts.
 */
export async function harvestLinkedInCompany(
  page: Page,
  company: CompanyRecord,
  opts: { maxPeople: number; delayMs: number },
): Promise<LinkedInHarvestResult> {
  const notes: string[] = [];
  const harvestedAt = new Date().toISOString();
  if (!company.linkedinUrl) {
    return {
      companyId: company.id,
      companyName: company.name,
      people: [],
      postSnippets: [],
      postKeywords: [],
      buyingHints: [],
      harvestedAt,
      notes: ["no_linkedin_url"],
    };
  }

  assertJobRuntime();
  assertWithinCap("profile_view");
  assertWithinCap("page_view");

  // --- About (explicit /about/ + click fallback) ---
  await page.goto(aboutUrl(company.linkedinUrl), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanBrowseProfile(page);
  assertNotLogin(page, `about ${company.name}`);
  recordAction("profile_view");
  recordAction("page_view");

  if (!/\/about/i.test(page.url())) {
    await page.goto(companySlugUrl(company.linkedinUrl), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await humanDelay("nav");
    const clicked = await clickAboutTab(page);
    notes.push(clicked ? "about_tab_clicked" : "about_tab_missing");
    recordAction("page_view");
  } else {
    notes.push("about_url_direct");
  }

  // Ensure About content loaded — click again if still on overview-only
  let aboutData = await extractAboutPanel(page);
  if (!aboutData.website) {
    await clickAboutTab(page);
    await page.mouse.wheel(0, 600);
    await humanDelay("read_card", { minMs: 600 });
    aboutData = await extractAboutPanel(page);
  }

  if (aboutData.website) notes.push("website_from_linkedin_about");
  else notes.push("website_not_found_on_about");

  // --- People (local search on company People tab) ---
  let people: DiscoveredPerson[] = [];
  try {
    people = await localPeopleSearch(
      page,
      company.linkedinUrl,
      opts.maxPeople,
      opts.delayMs,
    );
    notes.push(`people_local_search:${people.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notes.push(`people_fail:${message.slice(0, 120)}`);
    if (/login|checkpoint|restriction/i.test(message)) throw err;
  }

  // --- Posts (tech / buying signals) ---
  let postSnippets: string[] = [];
  let postKeywords: string[] = [];
  let buyingHints: string[] = [];
  let careersMentionsHiring = false;
  try {
    const posts = await scrapeRecentPosts(
      page,
      company.linkedinUrl,
      opts.delayMs,
    );
    postSnippets = posts.snippets;
    postKeywords = posts.keywords;
    buyingHints = posts.buyingHints;
    careersMentionsHiring = posts.careersMentionsHiring;
    notes.push(`posts_scraped:${postSnippets.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notes.push(`posts_fail:${message.slice(0, 120)}`);
    if (/login|checkpoint|restriction/i.test(message)) throw err;
  }

  return {
    companyId: company.id,
    companyName: company.name,
    linkedinUrl: company.linkedinUrl,
    websiteUrl: aboutData.website,
    about: aboutData.about,
    industry: aboutData.industry,
    employeeCount: aboutData.employeeCount,
    location: aboutData.location,
    tagline: aboutData.tagline,
    people,
    postSnippets,
    postKeywords,
    buyingHints,
    careersMentionsHiring,
    harvestedAt,
    notes,
  };
}

export function harvestToTechSignals(
  harvest: LinkedInHarvestResult,
): TechSignals | undefined {
  if (
    !harvest.postSnippets.length &&
    !harvest.postKeywords.length &&
    !harvest.buyingHints.length
  ) {
    return undefined;
  }
  return {
    checkedAt: harvest.harvestedAt,
    careersMentionsHiring: harvest.careersMentionsHiring,
    stackKeywords: harvest.postKeywords,
    vendorKeywords: harvest.postKeywords.filter((k) =>
      /salesforce|sap|oracle|aws|azure|gcp|hubspot|shopify/i.test(k),
    ),
    rawSnippets: harvest.postSnippets,
    buyingHints: [
      ...harvest.buyingHints,
      ...(harvest.postSnippets.length ? ["linkedin_recent_posts"] : []),
    ],
  };
}
