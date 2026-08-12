/**
 * Google / Gmail session paths and helpers (separate Chromium profile from LinkedIn).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const AUTH_DIR = path.join(projectRoot, "auth");
export const GOOGLE_STORAGE_STATE = path.join(AUTH_DIR, "google.json");
export const GOOGLE_USER_DATA_DIR = path.join(
  projectRoot,
  ".pw-user-data",
  "google",
);

export const GMAIL_INBOX_URL = "https://mail.google.com/mail/u/0/#inbox";
export const GOOGLE_ACCOUNT_URL = "https://myaccount.google.com/";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function googleContextOptions(headless?: boolean) {
  const resolved =
    headless ??
    (process.env.HEADLESS === "true" || process.env.HEADLESS === "1");
  return {
    headless: resolved,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    userAgent: DEFAULT_UA,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
  };
}

export function looksLikeGoogleLogin(url: string): boolean {
  try {
    const lower = url.toLowerCase();
    return (
      lower.includes("accounts.google.com") ||
      lower.includes("/signin") ||
      lower.includes("ServiceLogin".toLowerCase()) ||
      lower.includes("challenge") ||
      lower.includes("identifier")
    );
  } catch {
    return false;
  }
}

export function looksLikeGmail(url: string): boolean {
  try {
    const { hostname, pathname, hash } = new URL(url);
    if (!hostname.includes("mail.google.com")) return false;
    if (looksLikeGoogleLogin(url)) return false;
    return (
      pathname.includes("/mail") ||
      hash.includes("inbox") ||
      hash.includes("compose")
    );
  } catch {
    return false;
  }
}

/** Navigate to Gmail and confirm we are not on the Google login wall. */
export async function verifyGmailLoads(
  page: Page,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; url: string }> {
  await page.goto(GMAIL_INBOX_URL, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(2_000);

  const url = page.url();
  const composeVisible = await page
    .getByRole("button", { name: /compose/i })
    .first()
    .isVisible()
    .catch(() => false);
  const ok =
    !looksLikeGoogleLogin(url) && (looksLikeGmail(url) || composeVisible);
  return { ok, url };
}

export function hasGoogleAuth(): boolean {
  return (
    fs.existsSync(GOOGLE_STORAGE_STATE) || fs.existsSync(GOOGLE_USER_DATA_DIR)
  );
}

type StoredState = {
  cookies?: Parameters<BrowserContext["addCookies"]>[0];
};

export async function applyGoogleStorageStateFile(
  context: BrowserContext,
  statePath: string = GOOGLE_STORAGE_STATE,
): Promise<number> {
  if (!fs.existsSync(statePath)) return 0;
  const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as StoredState;
  const cookies = raw.cookies ?? [];
  if (cookies.length === 0) return 0;
  await context.addCookies(cookies);
  return cookies.length;
}
