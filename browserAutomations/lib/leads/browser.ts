import fs from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  LINKEDIN_STORAGE_STATE,
  LINKEDIN_USER_DATA_DIR,
  applyStorageStateFile,
  linkedInContextOptions,
  looksLikeLoginOrChallenge,
  verifyFeedLoads,
} from "../auth.js";
import {
  ProfileBusyError,
  assertJobRuntime,
  assertNoRestriction,
  beginJobRuntime,
  humanDelay,
  withLinkedInJobGuard,
} from "../linkedin-safety.js";
import { isHeadless, webUseSystemChrome } from "./env.js";

export function assertNotLogin(page: Page, contextLabel: string): void {
  const url = page.url();
  // Hard restriction/checkpoint first — cool down, do not treat as simple re-auth
  assertNoRestriction(url, contextLabel);
  if (looksLikeLoginOrChallenge(url)) {
    throw new Error(
      `Redirected to login/checkpoint during ${contextLabel} (url=${url}). ` +
        "Run `npm run auth:linkedin` and try again.",
    );
  }
}

export async function launchLinkedInContext(headless = isHeadless()): Promise<{
  context: BrowserContext;
  browser: Browser | null;
  mode: "persistent" | "storageState";
}> {
  const opts = {
    ...linkedInContextOptions(headless),
    acceptDownloads: true,
  };
  fs.mkdirSync(LINKEDIN_USER_DATA_DIR, { recursive: true });

  try {
    const context = await chromium.launchPersistentContext(
      LINKEDIN_USER_DATA_DIR,
      opts,
    );
    await applyStorageStateFile(context);
    return { context, browser: null, mode: "persistent" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const profileBusy =
      /existing browser session|user data dir|profile is already in use|SingletonLock/i.test(
        message,
      );
    if (profileBusy) {
      throw new ProfileBusyError(
        "Chromium SingletonLock / user-data-dir already open",
      );
    }
    throw err;
  }
}

export async function withLinkedInPage<T>(
  fn: (page: Page, context: BrowserContext) => Promise<T>,
  options?: { jobId?: string; headless?: boolean },
): Promise<T> {
  const {
    getSharedLeadBrowsers,
    ensureSharedLinkedIn,
  } = await import("./browser-session.js");

  // Reuse pipeline/job-wide browser when a shared scope is open
  if (getSharedLeadBrowsers()) {
    const li = await ensureSharedLinkedIn(options?.headless);
    assertJobRuntime();
    return fn(li.page, li.context);
  }

  const jobId = options?.jobId ?? "linkedin";
  return withLinkedInJobGuard(jobId, async () => {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      const launched = await launchLinkedInContext(options?.headless);
      browser = launched.browser;
      context = launched.context;
      const page = context.pages()[0] ?? (await context.newPage());
      const auth = await verifyFeedLoads(page, context);
      assertNoRestriction(auth.url, "feed verify");
      if (!auth.ok || looksLikeLoginOrChallenge(auth.url)) {
        throw new Error(
          `Not authenticated (url=${auth.url}). Run \`npm run auth:linkedin\`.`,
        );
      }
      // Start runtime clock only after browser + auth are ready
      beginJobRuntime(jobId);
      assertJobRuntime();
      await humanDelay("nav");
      return await fn(page, context);
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  });
}

export function hasLinkedInAuth(): boolean {
  return (
    fs.existsSync(LINKEDIN_STORAGE_STATE) ||
    fs.existsSync(LINKEDIN_USER_DATA_DIR)
  );
}

const EPHEMERAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * Launch ephemeral Chromium for public-web work (no LinkedIn profile).
 * Prefers system Chrome when LEAD_WEB_USE_SYSTEM_CHROME=true (default).
 */
export async function launchEphemeralBrowser(
  headless = isHeadless(),
): Promise<Browser> {
  const preferChrome = webUseSystemChrome();
  if (preferChrome) {
    try {
      return await chromium.launch({ headless, channel: "chrome" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `System Chrome unavailable (${message.slice(0, 120)}); falling back to bundled Chromium.`,
      );
    }
  }
  return chromium.launch({ headless });
}

/** Launch a disposable browser (no LinkedIn profile) for web-only work. */
export async function withEphemeralBrowser<T>(
  fn: (browser: Browser) => Promise<T>,
  headless = isHeadless(),
): Promise<T> {
  const {
    getSharedLeadBrowsers,
    ensureSharedEphemeral,
  } = await import("./browser-session.js");

  if (getSharedLeadBrowsers()) {
    const browser = await ensureSharedEphemeral(headless);
    return fn(browser);
  }

  const browser = await launchEphemeralBrowser(headless);
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Fresh context+page on an existing ephemeral browser (isolate cookies/storage). */
export async function withEphemeralContextPage<T>(
  browser: Browser,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    userAgent: EPHEMERAL_UA,
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Lightweight Chromium for public website visits (no LinkedIn profile). */
export async function withEphemeralPage<T>(
  fn: (page: Page) => Promise<T>,
  headless = isHeadless(),
): Promise<T> {
  return withEphemeralBrowser(async (browser) => {
    return withEphemeralContextPage(browser, fn);
  }, headless);
}
