/** LinkedIn content/posts search for visibility engagement. */

import type { Page } from "playwright";
import { humanDelay } from "../linkedin-safety.js";
import { humanContentSearch } from "./search-ui.js";
import type { FoundPost } from "./types.js";
import { normalizeUrl, postKey, slugId } from "./io.js";

/** @deprecated Prefer humanContentSearch — kept for debugging only. */
export function buildContentSearchUrl(keyword: string): string {
  const params = new URLSearchParams();
  params.set("keywords", keyword);
  params.set("origin", "GLOBAL_SEARCH_HEADER");
  return `https://www.linkedin.com/search/results/content/?${params.toString()}`;
}

async function scrapeContentCards(
  page: Page,
  keyword: string,
  delayMs: number,
): Promise<FoundPost[]> {
  // Light scroll only — heavy scrolling is for the engage pass
  await page.mouse.wheel(0, 600);
  await humanDelay("read_card", { minMs: Math.min(delayMs, 1200) });

  const now = new Date().toISOString();
  const raw = (await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();

    function push(card) {
      const text = (card.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length < 25) return;

      let url = undefined;
      for (const a of Array.from(card.querySelectorAll("a[href]"))) {
        const href = a.href || "";
        if (
          /\\/feed\\/update|\\/posts\\/|activity:|urn:li:activity/i.test(href)
        ) {
          url = href.split("?")[0];
          break;
        }
      }

      let authorName = "";
      const actor = card.querySelector(
        ".update-components-actor__title span[aria-hidden='true'], .update-components-actor__name span[aria-hidden='true'], .entity-result__title-text span[aria-hidden='true'], span.update-components-actor__title",
      );
      if (actor) {
        authorName = (actor.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100);
      }

      let authorHeadline = "";
      const headline = card.querySelector(
        ".update-components-actor__description, .entity-result__primary-subtitle, .update-components-actor__supplementary-actor-info",
      );
      if (headline) {
        authorHeadline = (headline.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160);
      }

      let relativeTime = "";
      const timeEl = card.querySelector(
        "time, .update-components-actor__sub-description span[aria-hidden='true']",
      );
      if (timeEl) {
        relativeTime = (timeEl.getAttribute("datetime") || timeEl.textContent || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 80);
      }

      let body = "";
      const commentary = card.querySelector(
        ".update-components-text, .feed-shared-update-v2__description, .feed-shared-text, .break-words span[dir='ltr'], span.break-words",
      );
      if (commentary) {
        body = (commentary.textContent || "").replace(/\\s+/g, " ").trim();
      }
      if (!body || body.length < 20) {
        // Strip actor chrome; keep middle of card text
        body = text.slice(0, 900);
      }

      const key = (url || body.slice(0, 120)).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      out.push({
        url,
        authorName: authorName || undefined,
        authorHeadline: authorHeadline || undefined,
        text: body.slice(0, 900),
        relativeTime: relativeTime || undefined,
      });
    }

    const selectors = [
      ".feed-shared-update-v2",
      "div.feed-shared-update-v2__control-menu-container",
      ".reusable-search__result-container",
      "li.reusable-search__result-container",
      "div[data-chameleon-result-urn]",
      "div[data-view-name='feed-full-update']",
      "div[data-urn*='activity']",
      "article",
    ];
    for (const sel of selectors) {
      for (const card of Array.from(document.querySelectorAll(sel))) {
        push(card);
        if (out.length >= 20) return out;
      }
    }

    // Last resort: any link to an activity / post, climb to a card-ish parent
    for (const a of Array.from(document.querySelectorAll('a[href*="activity:"], a[href*="/posts/"], a[href*="/feed/update"]'))) {
      const card =
        a.closest("li") ||
        a.closest("article") ||
        a.closest("div.feed-shared-update-v2") ||
        a.closest("div[data-chameleon-result-urn]") ||
        a.parentElement;
      if (card) push(card);
      if (out.length >= 20) break;
    }
    return out;
  })()`)) as Array<{
    url?: string;
    authorName?: string;
    authorHeadline?: string;
    text: string;
    relativeTime?: string;
  }>;

  return raw.map((r) => {
    const activity =
      r.url?.match(/activity[:%3A-]?(\d+)/i)?.[1] ||
      r.url?.match(/urn:li:activity:(\d+)/i)?.[1];
    const key = postKey({ url: r.url, text: r.text });
    return {
      id: activity ? `vp-activity-${activity}` : slugId("vp", normalizeUrl(r.url) || key),
      url: r.url,
      authorName: r.authorName,
      authorHeadline: r.authorHeadline,
      text: r.text,
      keyword,
      discoveredAt: now,
      relativeTime: r.relativeTime,
    };
  });
}

export async function scrapePostsFromCurrentPage(
  page: Page,
  keyword: string,
  delayMs: number,
): Promise<FoundPost[]> {
  return scrapeContentCards(page, keyword, delayMs);
}

/**
 * Search LinkedIn content for each keyword via the search box (sequential).
 * Soft-stops on caps. Does not open individual post pages.
 */
export async function findRelatedPosts(
  page: Page,
  keywords: string[],
  options: { maxPosts: number; delayMs: number },
): Promise<FoundPost[]> {
  const collected: FoundPost[] = [];
  const seen = new Set<string>();

  for (const keyword of keywords) {
    if (collected.length >= options.maxPosts) break;

    await humanContentSearch(page, keyword, options.delayMs);

    const batch = await scrapeContentCards(page, keyword, options.delayMs);
    for (const post of batch) {
      const key = postKey(post);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(post);
      if (collected.length >= options.maxPosts) break;
    }

    await humanDelay("between_companies", {
      minMs: Math.min(options.delayMs, 2500),
    });
  }

  return collected.slice(0, options.maxPosts);
}
