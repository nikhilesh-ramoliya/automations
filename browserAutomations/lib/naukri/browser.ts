/** Launch Naukri persistent browser + page helpers. */

import fs from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  NAUKRI_STORAGE_STATE,
  NAUKRI_USER_DATA_DIR,
  applyNaukriStorageState,
  hasNaukriAuthFiles,
  looksLikeNaukriLogin,
  naukriContextOptions,
  verifyNaukriHome,
} from "../auth-naukri.js";
import {
  assertJobRuntime,
  beginJobRuntime,
  naukriDelay,
  withNaukriJobGuard,
} from "./safety.js";

export function hasNaukriAuth(): boolean {
  return hasNaukriAuthFiles();
}

export function assertNotNaukriLogin(page: Page, contextLabel: string): void {
  const url = page.url();
  if (looksLikeNaukriLogin(url)) {
    throw new Error(
      `Redirected to Naukri login during ${contextLabel} (url=${url}). ` +
        "Run `npm run auth:naukri` and try again.",
    );
  }
}

export async function launchNaukriContext(headless?: boolean): Promise<{
  context: BrowserContext;
  browser: Browser | null;
}> {
  fs.mkdirSync(NAUKRI_USER_DATA_DIR, { recursive: true });
  const opts = {
    ...naukriContextOptions(headless),
    acceptDownloads: true,
  };

  try {
    const context = await chromium.launchPersistentContext(
      NAUKRI_USER_DATA_DIR,
      opts,
    );
    await applyNaukriStorageState(context);
    return { context, browser: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      /existing browser session|user data dir|profile is already in use|SingletonLock/i.test(
        message,
      )
    ) {
      throw new Error(
        "Naukri Chromium profile already in use. Close other Naukri automation windows and retry.",
      );
    }
    throw err;
  }
}

export async function withNaukriPage<T>(
  fn: (page: Page, context: BrowserContext) => Promise<T>,
  options?: { jobId?: string; headless?: boolean },
): Promise<T> {
  const jobId = options?.jobId ?? "naukri";
  return withNaukriJobGuard(jobId, async () => {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      const launched = await launchNaukriContext(options?.headless);
      browser = launched.browser;
      context = launched.context;
      const page = context.pages()[0] ?? (await context.newPage());
      const auth = await verifyNaukriHome(page, context);
      if (!auth.ok || looksLikeNaukriLogin(auth.url)) {
        throw new Error(
          `Not authenticated on Naukri (url=${auth.url}). Run \`npm run auth:naukri\`.`,
        );
      }
      beginJobRuntime(jobId);
      assertJobRuntime();
      await naukriDelay("nav");
      return await fn(page, context);
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  });
}

export { NAUKRI_STORAGE_STATE };
