/**
 * One-off: open LinkedIn, type a Posts search, dump filter controls + card counts.
 * Usage: npx tsx scripts/debug-visibility-search.ts
 */
import "dotenv/config";
import { withLinkedInPage } from "../lib/leads/browser.js";
import { humanContentSearch } from "../lib/visibility/search-ui.js";

const keyword = process.env.VISIBILITY_KEYWORDS?.split(",")[0]?.trim() || "IT consulting";

await withLinkedInPage(
  async (page) => {
    await humanContentSearch(page, keyword, 1500);
    const url = page.url();
    console.log("URL:", url);

    const dump = await page.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll("button, a[role='button'], [role='radio']"))
        .slice(0, 80)
        .map((el) => ({
          tag: el.tagName,
          text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
          aria: el.getAttribute("aria-label") || "",
        }))
        .filter((b) => /filter|sort|latest|date|post|result|show/i.test(b.text + " " + b.aria));
      const cards = {
        feed: document.querySelectorAll(".feed-shared-update-v2").length,
        reusable: document.querySelectorAll(".reusable-search__result-container").length,
        chameleon: document.querySelectorAll("div[data-chameleon-result-urn]").length,
        activityLinks: document.querySelectorAll('a[href*="activity:"]').length,
        updateLinks: document.querySelectorAll('a[href*="/feed/update"]').length,
      };
      return { buttons, cards, title: document.title };
    })()`);

    console.log(JSON.stringify(dump, null, 2));
  },
  { jobId: "visibility-pipeline" },
);
