/**
 * Human-like LinkedIn search: type into the global search box (no deep-link SERP URLs).
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
    page.locator('input.search-global-typeahead__input').first(),
    page.locator('input[aria-label*="Search" i]').first(),
    page.getByRole("combobox", { name: /search/i }).first(),
  ];
  for (const loc of candidates) {
    if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) return loc;
  }
  return null;
}

/** Click the Posts / Content filter after a keyword search (UI, not URL). */
async function selectPostsFilter(page: Page): Promise<boolean> {
  const filters = [
    page.getByRole("button", { name: /^Posts$/i }).first(),
    page.getByRole("link", { name: /^Posts$/i }).first(),
    page.locator('button:has-text("Posts")').first(),
    page.locator('a[href*="results/content"]').first(),
  ];
  for (const loc of filters) {
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanDelay("click");
      await loc.click().catch(() => undefined);
      await humanDelay("search", { minMs: 1200, maxMs: 2800 });
      console.log("  Switched to Posts filter");
      return true;
    }
  }
  console.log("  Posts filter not found — may still be on All results");
  return false;
}

/**
 * Prefer Latest + recent Date posted via All filters (LinkedIn Posts search).
 * Falls back to any visible Sort-by control if the panel isn't available.
 */
async function sortPostsByDatePosted(page: Page): Promise<boolean> {
  const root = page.locator("main").first();
  const scope = (await root.count().catch(() => 0)) > 0 ? root : page;

  const allFiltersTriggers = [
    scope.getByRole("button", { name: /all filters/i }).first(),
    scope.locator('button:has-text("All filters")').first(),
    page.getByRole("button", { name: /all filters/i }).first(),
  ];

  let openedFilters = false;
  for (const trigger of allFiltersTriggers) {
    if (await trigger.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanDelay("click");
      await trigger.click().catch(() => undefined);
      await humanDelay("search", { minMs: 800, maxMs: 1800 });
      openedFilters = true;
      break;
    }
  }

  if (openedFilters) {
    const panel = page
      .locator(
        '[role="dialog"], .search-reusables__filters-modal, .artdeco-modal, aside, form',
      )
      .filter({ hasText: /sort by|date posted/i })
      .first();
    const panelReady = await panel
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const clickIn = panelReady ? panel : page;

    // Prefer Latest sort only — date-range filters (Past week) often empty niche queries
    let appliedLatest = false;
    const latestChoices = [
      clickIn.getByRole("radio", { name: /^Latest$/i }).first(),
      clickIn.getByLabel(/^Latest$/i).first(),
      clickIn.locator('label:has-text("Latest")').first(),
      clickIn.locator(':text-is("Latest")').first(),
    ];
    for (const loc of latestChoices) {
      if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
        await humanDelay("click");
        await loc.click().catch(() => undefined);
        await humanDelay("idle_micro");
        appliedLatest = true;
        console.log("  All filters → Sort by Latest");
        break;
      }
    }

    // Optional broader date window (Past month) — skip Past week/24h (too sparse)
    let appliedDate = false;
    if (process.env.VISIBILITY_DATE_FILTER !== "false") {
      const dateChoices = [
        clickIn.getByRole("radio", { name: /past month/i }).first(),
        clickIn.getByLabel(/past month/i).first(),
        clickIn.locator('label:has-text("Past month")').first(),
      ];
      for (const loc of dateChoices) {
        if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
          await humanDelay("click");
          await loc.click().catch(() => undefined);
          await humanDelay("idle_micro");
          appliedDate = true;
          console.log("  All filters → Date posted (Past month)");
          break;
        }
      }
    }

    const showResults = [
      clickIn.getByRole("button", { name: /show\s+\d*\s*results/i }).first(),
      page.getByRole("button", { name: /show\s+\d*\s*results/i }).first(),
      clickIn.getByRole("button", { name: /show results/i }).first(),
      page.getByRole("button", { name: /show results/i }).first(),
      page.locator('button.artdeco-button--primary:has-text("Show")').first(),
      page.locator('button:has-text("Show results")').first(),
    ];
    let showed = false;
    for (const loc of showResults) {
      if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
        await humanDelay("click");
        await loc.click().catch(() => undefined);
        await humanDelay("search", { minMs: 1800, maxMs: 3500 });
        showed = true;
        break;
      }
    }

    if (appliedLatest || appliedDate || showed) {
      if (!showed) {
        // Some UIs apply filters live; dismiss panel
        await page.keyboard.press("Escape").catch(() => undefined);
        await humanDelay("search", { minMs: 1200, maxMs: 2500 });
      }
      console.log("  Applied All filters (Latest + date)");
      return true;
    }

    await page.keyboard.press("Escape").catch(() => undefined);
  }

  // Fallback: inline Sort by dropdown on the results bar
  const sortTriggers = [
    scope.getByRole("button", { name: /sort by/i }).first(),
    scope.locator('button:has-text("Sort by")').first(),
    scope.locator('button:has-text("Top match")').first(),
    scope.locator('button[aria-label*="Sort" i]').first(),
  ];

  let opened = false;
  for (const trigger of sortTriggers) {
    if (await trigger.isVisible({ timeout: 1500 }).catch(() => false)) {
      await humanDelay("click");
      await trigger.click().catch(() => undefined);
      await humanDelay("idle_micro");
      opened = true;
      break;
    }
  }

  const dateOptions = [
    page
      .getByRole("menuitemradio", { name: /date posted|latest|recent/i })
      .first(),
    page.getByRole("option", { name: /date posted|latest|recent/i }).first(),
    page.getByRole("menuitem", { name: /date posted|latest|recent/i }).first(),
    page.locator('[role="listbox"] [role="option"]:has-text("Latest")').first(),
    page
      .locator('[role="listbox"] [role="option"]:has-text("Date posted")')
      .first(),
  ];

  for (const opt of dateOptions) {
    if (await opt.isVisible({ timeout: 1500 }).catch(() => false)) {
      await humanDelay("click");
      await opt.click().catch(() => undefined);
      await humanDelay("search", { minMs: 1500, maxMs: 3200 });
      console.log("  Sorted posts by Latest / Date posted");
      return true;
    }
  }

  if (opened) {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  console.log("  Sort-by-date control not found — keeping LinkedIn default sort");
  return false;
}

/** Light human scroll to load a few more posts into view. */
export async function humanScrollPosts(
  page: Page,
  rounds = 2,
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const delta = 700 + Math.floor(Math.random() * 900);
    await page.mouse.wheel(0, delta);
    await humanDelay("read_card", { minMs: 1000, maxMs: 2400 });
  }
}

/**
 * Search LinkedIn like a person:
 * feed → type query → Enter → Posts → Sort by Date posted → light scroll.
 * Does not use constructed search URLs or open individual post pages.
 */
export async function humanContentSearch(
  page: Page,
  keyword: string,
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
    await input.pressSequentially(keyword, {
      delay: 45 + Math.floor(Math.random() * 40),
    });
  } catch {
    await page.keyboard.type(keyword, {
      delay: 45 + Math.floor(Math.random() * 40),
    });
  }
  await humanDelay("invite_think", { minMs: 400, maxMs: 1200 });
  await input.press("Enter");

  await humanDelay("search", { minMs: delayMs });
  assertNotLogin(page, `search ${keyword}`);
  recordAction("search");

  // Prefer Posts results via UI filter
  await selectPostsFilter(page);
  await sortPostsByDatePosted(page);

  await page
    .locator(
      ".feed-shared-update-v2, .reusable-search__result-container, div[data-chameleon-result-urn], main",
    )
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);

  // Confirm we landed on content/posts results when possible
  const url = page.url();
  if (!/results\/content|\/search\/results/i.test(url)) {
    console.log(`  Search landed on: ${url.slice(0, 120)}`);
  }

  await humanScrollPosts(page, 3 + Math.floor(Math.random() * 2));

  // If filters yielded an empty SERP, dismiss and keep Posts (better than 0 cards)
  const cardCount = await page
    .locator(
      ".feed-shared-update-v2, div[data-chameleon-result-urn], a[href*='activity:'], a[href*='ugcPost:'], a[href*='share:']",
    )
    .count()
    .catch(() => 0);
  if (cardCount < 1) {
    console.log("  Few/no post cards after filters — relaxing date filter");
    await page.keyboard.press("Escape").catch(() => undefined);
    // Re-open All filters and clear date / show all dates if possible
    const allFilters = page.getByRole("button", { name: /all filters/i }).first();
    if (await allFilters.isVisible({ timeout: 1500 }).catch(() => false)) {
      await allFilters.click().catch(() => undefined);
      await humanDelay("idle_micro");
      const anyTime = page.getByRole("radio", { name: /any time|all time/i }).first();
      if (await anyTime.isVisible({ timeout: 1000 }).catch(() => false)) {
        await anyTime.click().catch(() => undefined);
      }
      const show = page.getByRole("button", { name: /show\s+\d*\s*results/i }).first();
      if (await show.isVisible({ timeout: 1500 }).catch(() => false)) {
        await show.click().catch(() => undefined);
        await humanDelay("search", { minMs: 1500, maxMs: 3000 });
      } else {
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    }
    await humanScrollPosts(page, 2);
  }

  await page.evaluate(`window.scrollTo({ top: 0, behavior: "instant" })`);
  await humanDelay("idle_micro");
}
