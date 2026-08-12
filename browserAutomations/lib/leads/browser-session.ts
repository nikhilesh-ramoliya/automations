/**
 * Shared browser session scope for a full lead pipeline (or multi-step) run.
 *
 * `withSharedLeadBrowsers` opens a scope; LinkedIn / ephemeral Chromium are
 * created lazily on first use and closed once when the scope ends — so we do
 * not relaunch between jobs or between companies.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import {
  looksLikeLoginOrChallenge,
  verifyFeedLoads,
} from "../auth.js";
import {
  assertNoRestriction,
  beginJobRuntime,
  humanDelay,
  withLinkedInJobGuard,
} from "../linkedin-safety.js";
import { isHeadless } from "./env.js";
import { launchEphemeralBrowser, launchLinkedInContext } from "./browser.js";

export type SharedLinkedIn = {
  context: BrowserContext;
  browser: Browser | null;
  page: Page;
};

export type SharedLeadBrowsers = {
  jobId: string;
  headless: boolean;
  linkedIn: SharedLinkedIn | null;
  ephemeralBrowser: Browser | null;
  runtimeStarted: boolean;
};

let active: SharedLeadBrowsers | null = null;

export function getSharedLeadBrowsers(): SharedLeadBrowsers | null {
  return active;
}

export function hasSharedLeadBrowsers(): boolean {
  return active !== null;
}

/** Lazily open LinkedIn into the active shared scope (must be inside withSharedLeadBrowsers). */
export async function ensureSharedLinkedIn(
  headless?: boolean,
): Promise<SharedLinkedIn> {
  if (!active) {
    throw new Error("ensureSharedLinkedIn called outside withSharedLeadBrowsers");
  }
  if (active.linkedIn) return active.linkedIn;

  const launched = await launchLinkedInContext(headless ?? active.headless);
  const page =
    launched.context.pages()[0] ?? (await launched.context.newPage());
  const auth = await verifyFeedLoads(page, launched.context);
  assertNoRestriction(auth.url, "feed verify");
  if (!auth.ok || looksLikeLoginOrChallenge(auth.url)) {
    await launched.context.close().catch(() => undefined);
    await launched.browser?.close().catch(() => undefined);
    throw new Error(
      `Not authenticated (url=${auth.url}). Run \`npm run auth:linkedin\`.`,
    );
  }
  if (!active.runtimeStarted) {
    beginJobRuntime(active.jobId);
    active.runtimeStarted = true;
  }
  await humanDelay("nav");
  active.linkedIn = {
    context: launched.context,
    browser: launched.browser,
    page,
  };
  console.log("[browsers] LinkedIn session opened (shared for this run).");
  return active.linkedIn;
}

/** Lazily open ephemeral Chromium into the active shared scope. */
export async function ensureSharedEphemeral(
  headless?: boolean,
): Promise<Browser> {
  if (!active) {
    throw new Error(
      "ensureSharedEphemeral called outside withSharedLeadBrowsers",
    );
  }
  if (active.ephemeralBrowser) return active.ephemeralBrowser;
  active.ephemeralBrowser = await launchEphemeralBrowser(
    headless ?? active.headless,
  );
  console.log("[browsers] Ephemeral web browser opened (shared for this run).");
  return active.ephemeralBrowser;
}

/**
 * Hold one browser scope for `fn`. Nested calls reuse the same scope.
 * Browsers are launched on demand via withLinkedInPage / withEphemeralBrowser.
 */
export async function withSharedLeadBrowsers<T>(
  fn: () => Promise<T>,
  options?: { jobId?: string; headless?: boolean },
): Promise<T> {
  if (active) {
    return fn();
  }

  const jobId = options?.jobId ?? "lead-pipeline";
  const headless = options?.headless ?? isHeadless();

  return withLinkedInJobGuard(jobId, async () => {
    active = {
      jobId,
      headless,
      linkedIn: null,
      ephemeralBrowser: null,
      runtimeStarted: false,
    };
    console.log(
      `\n[browsers] Shared browser scope started (job=${jobId}) — one instance for this run.\n`,
    );
    try {
      return await fn();
    } finally {
      const session = active;
      active = null;
      console.log("\n[browsers] Closing shared browsers…\n");
      await session?.linkedIn?.context.close().catch(() => undefined);
      await session?.linkedIn?.browser?.close().catch(() => undefined);
      await session?.ephemeralBrowser?.close().catch(() => undefined);
    }
  });
}
