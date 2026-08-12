/**
 * Human-like browsing helpers (scroll / glance) for LinkedIn & web pages.
 */

import type { Page } from "playwright";
import { humanDelay } from "./linkedin-safety.js";

function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Scroll the page in uneven chunks (not a fixed pattern), with short pauses.
 * Mimics reading while moving through a feed / profile / search results.
 */
export async function humanScroll(
  page: Page,
  opts?: {
    /** Number of scroll bursts (default 1–3). */
    passes?: number;
    /** Prefer scrolling down (default) or mix in occasional up. */
    allowUp?: boolean;
  },
): Promise<void> {
  const passes = opts?.passes ?? randInt(1, 3);
  const allowUp = opts?.allowUp ?? true;

  for (let i = 0; i < passes; i++) {
    const down = !allowUp || Math.random() > 0.18;
    const delta = randInt(280, 720) * (down ? 1 : -1);
    await page.mouse.wheel(0, delta).catch(() => undefined);
    await humanDelay("idle_micro", {
      minMs: 400,
      maxMs: 2200,
      distraction: false,
      skipBurstCheck: true,
    });
  }
}

/**
 * Spend time on a profile/page: scroll + long read pause (20–60s typical via read_profile).
 */
export async function humanBrowseProfile(
  page: Page,
  opts?: { scrollPasses?: number },
): Promise<void> {
  await humanScroll(page, {
    passes: opts?.scrollPasses ?? randInt(2, 4),
    allowUp: true,
  });
  await humanDelay("read_profile");
  // Occasional second glance scroll
  if (Math.random() < 0.45) {
    await humanScroll(page, { passes: 1, allowUp: true });
    await humanDelay("idle_micro", { minMs: 800, maxMs: 2500, skipBurstCheck: true });
  }
}
