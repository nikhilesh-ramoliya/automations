/**
 * Send email via Gmail in a persistent Google Chromium profile.
 */

import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  GOOGLE_STORAGE_STATE,
  GOOGLE_USER_DATA_DIR,
  applyGoogleStorageStateFile,
  googleContextOptions,
  verifyGmailLoads,
} from "../auth-google.js";

export type GmailSendResult =
  | { ok: true; mode: "sent" | "dry_run"; to: string }
  | { ok: false; error: string; to: string };

async function launchGoogleContext(headless?: boolean): Promise<{
  context: BrowserContext;
  browser: Browser | null;
}> {
  fs.mkdirSync(GOOGLE_USER_DATA_DIR, { recursive: true });
  const opts = {
    ...googleContextOptions(headless),
    acceptDownloads: true,
  };
  try {
    const context = await chromium.launchPersistentContext(
      GOOGLE_USER_DATA_DIR,
      {
        ...opts,
        ...(process.env.GOOGLE_USE_CHROME === "false"
          ? {}
          : { channel: "chrome" as const }),
      },
    );
    await applyGoogleStorageStateFile(context);
    return { context, browser: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/SingletonLock|already in use|user data dir/i.test(message)) {
      throw new Error(
        "Google profile busy — close other windows using .pw-user-data/google",
      );
    }
    const context = await chromium.launchPersistentContext(
      GOOGLE_USER_DATA_DIR,
      opts,
    );
    await applyGoogleStorageStateFile(context);
    return { context, browser: null };
  }
}

export async function withGmailPage<T>(
  fn: (page: Page, context: BrowserContext) => Promise<T>,
  headless?: boolean,
): Promise<T> {
  const { context, browser } = await launchGoogleContext(headless);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const auth = await verifyGmailLoads(page);
    if (!auth.ok) {
      throw new Error(
        `Not signed into Gmail (url=${auth.url}). Run \`npm run auth:google\`.`,
      );
    }
    return await fn(page, context);
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

function encodeQuery(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

/**
 * Open Gmail compose (URL params) and optionally click Send.
 * LinkedIn-style dry-run: fill compose but do not click Send when dryRun.
 */
export async function sendGmailCompose(
  page: Page,
  opts: {
    to: string;
    subject: string;
    body: string;
    dryRun: boolean;
  },
): Promise<GmailSendResult> {
  const to = opts.to.trim();
  if (!to || !to.includes("@")) {
    return { ok: false, to, error: "invalid_email" };
  }

  const url =
    `https://mail.google.com/mail/?view=cm&fs=1&tf=1` +
    `&to=${encodeQuery(to)}` +
    `&su=${encodeQuery(opts.subject)}` +
    `&body=${encodeQuery(opts.body)}`;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);

  // Ensure To / subject landed (Gmail sometimes strips body from URL — refill)
  const toField = page.locator('textarea[name="to"], input[peoplekit-id], [aria-label*="To"]').first();
  const subjectField = page.locator('input[name="subjectbox"], input[aria-label*="Subject"]').first();
  const bodyField = page.locator('div[aria-label*="Message Body"], div[role="textbox"]').first();

  if (await subjectField.isVisible().catch(() => false)) {
    const cur = (await subjectField.inputValue().catch(() => "")) || "";
    if (!cur.trim()) {
      await subjectField.fill(opts.subject);
    }
  }
  if (await bodyField.isVisible().catch(() => false)) {
    const text = (await bodyField.innerText().catch(() => "")) || "";
    if (!text.trim()) {
      await bodyField.click();
      await page.keyboard.type(opts.body, { delay: 15 });
    }
  }

  if (opts.dryRun) {
    console.log(`[gmail dry-run] Would send to ${to}: ${opts.subject}`);
    // Close compose without sending
    await page.keyboard.press("Escape").catch(() => undefined);
    return { ok: true, mode: "dry_run", to };
  }

  const sendBtn = page
    .getByRole("button", { name: /^send$/i })
    .or(page.locator('div[role="button"][aria-label*="Send"]'))
    .first();
  if (!(await sendBtn.isVisible().catch(() => false))) {
    return { ok: false, to, error: "send_button_not_found" };
  }
  await sendBtn.click();
  await page.waitForTimeout(2_000);
  // Ignore unused toField — kept for future validation
  void toField;
  return { ok: true, mode: "sent", to };
}

export function hasGoogleSessionFiles(): boolean {
  return (
    fs.existsSync(GOOGLE_STORAGE_STATE) || fs.existsSync(GOOGLE_USER_DATA_DIR)
  );
}
