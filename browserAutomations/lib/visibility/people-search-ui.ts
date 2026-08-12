/**
 * Human-like LinkedIn People search (typeahead → People filter).
 * No deep-link SERP URLs.
 */

import type { Page } from "playwright";
import {
  assertJobRuntime,
  assertWithinCap,
  humanDelay,
  recordAction,
} from "../linkedin-safety.js";
import { assertNotLogin } from "../leads/browser.js";

const FEED_URL = "https://www.linkedin.com/feed/";

async function ensureOnLinkedIn(page: Page, delayMs: number): Promise<void> {
  const url = page.url();
  if (/linkedin\.com/i.test(url) && !/\/login|\/uas\/|checkpoint/i.test(url)) {
    return;
  }
  assertWithinCap("page_view");
  await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay("nav", { minMs: delayMs });
  assertNotLogin(page, "open LinkedIn feed");
  recordAction("page_view");
}

async function findGlobalSearchInput(page: Page) {
  const candidates = [
    page.locator('input[placeholder*="Search" i]').first(),
    page.locator("input.search-global-typeahead__input").first(),
    page.locator('input[aria-label*="Search" i]').first(),
    page.getByRole("combobox", { name: /search/i }).first(),
  ];
  for (const loc of candidates) {
    if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) return loc;
  }
  return null;
}

async function selectPeopleFilter(page: Page): Promise<boolean> {
  const filters = [
    page.getByRole("button", { name: /^People$/i }).first(),
    page.getByRole("link", { name: /^People$/i }).first(),
    page.locator('button:has-text("People")').first(),
    page.locator('a[href*="results/people"]').first(),
  ];
  for (const loc of filters) {
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanDelay("click");
      await loc.click().catch(() => undefined);
      await humanDelay("search", { minMs: 1200, maxMs: 2800 });
      console.log("  Switched to People filter");
      return true;
    }
  }
  console.log("  People filter not found — may still be on All results");
  return false;
}

export type PeopleSerpCard = {
  name: string;
  title?: string;
  profileUrl: string;
  location?: string;
};

/** Scrape visible people cards from current People SERP (no profile opens). */
export async function scrapePeopleFromSerp(
  page: Page,
  max = 20,
): Promise<PeopleSerpCard[]> {
  return (await page.evaluate(`((max) => {
    const out = [];
    const seen = new Set();
    const anchors = Array.from(
      document.querySelectorAll('a[href*="/in/"]'),
    );
    for (const a of anchors) {
      const href = (a.href || "").split("?")[0].replace(/\\/$/, "");
      if (!/linkedin\\.com\\/in\\/[^/]+$/i.test(href)) continue;
      const key = href.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const card =
        a.closest("li") ||
        a.closest(".reusable-search__result-container") ||
        a.closest("div[data-chameleon-result-urn]") ||
        a.parentElement;
      const text = (card?.textContent || a.textContent || "")
        .replace(/\\s+/g, " ")
        .trim();
      // Skip "Message" / connection chrome as names
      let name = (a.textContent || "").replace(/\\s+/g, " ").trim();
      if (!name || name.length < 2 || /^(message|connect|follow|pending)$/i.test(name)) {
        const aria = a.getAttribute("aria-label") || "";
        name = aria.replace(/\\s*View .+ profile.*/i, "").trim() || name;
      }
      if (!name || name.length < 2) continue;

      // Headline often after name in card text
      let title = undefined;
      const after = text.slice(text.indexOf(name) + name.length).trim();
      const m = after.match(/^(.{8,120}?)(?:\\s{2,}|\\d+(?:st|nd|rd|th)|Connect|Message|Follow)/i);
      if (m) title = m[1].replace(/\\s+/g, " ").trim();

      out.push({
        name: name.slice(0, 120),
        title: title?.slice(0, 180),
        profileUrl: href,
      });
      if (out.length >= max) break;
    }
    return out;
  })(${max})`)) as PeopleSerpCard[];
}

/**
 * Search LinkedIn People like a human:
 * feed → type query → Enter → People filter → light scroll.
 */
export async function humanPeopleSearch(
  page: Page,
  query: string,
  delayMs: number,
): Promise<void> {
  assertJobRuntime();
  assertWithinCap("search");

  await ensureOnLinkedIn(page, delayMs);

  const input = await findGlobalSearchInput(page);
  if (!input) {
    throw new Error(
      "LinkedIn global search input not found. Are you on the feed?",
    );
  }

  await humanDelay("click");
  await input.click();
  await humanDelay("type_burst");
  await input.fill("");
  await humanDelay("idle_micro");

  try {
    await input.pressSequentially(query, {
      delay: 45 + Math.floor(Math.random() * 40),
    });
  } catch {
    await page.keyboard.type(query, {
      delay: 45 + Math.floor(Math.random() * 40),
    });
  }
  await humanDelay("invite_think", { minMs: 400, maxMs: 1200 });
  await input.press("Enter");

  await humanDelay("search", { minMs: delayMs });
  assertNotLogin(page, `people search ${query}`);
  recordAction("search");

  await selectPeopleFilter(page);

  await page
    .locator(
      'a[href*="/in/"], .reusable-search__result-container, main',
    )
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);

  // Load a few more results
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 700 + Math.floor(Math.random() * 500));
    await humanDelay("read_card", { minMs: 800, maxMs: 1800 });
  }
  await page.evaluate(`window.scrollTo({ top: 0, behavior: "instant" })`);
  await humanDelay("idle_micro");
}
