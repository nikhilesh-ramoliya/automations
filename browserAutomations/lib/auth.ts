import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Cookie, Page } from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Directory for saved browser storage states (gitignored). */
export const AUTH_DIR = path.join(projectRoot, "auth");

/** LinkedIn session storage state path — load this in later automations. */
export const LINKEDIN_STORAGE_STATE = path.join(AUTH_DIR, "linkedin.json");

/**
 * Persistent Chromium profile for LinkedIn (gitignored).
 * Prefer this over ephemeral contexts so cookies/localStorage survive reliably.
 */
export const LINKEDIN_USER_DATA_DIR = path.join(
  projectRoot,
  ".pw-user-data",
  "linkedin",
);

export const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";

const FEED_URL_HINTS = [
  "/feed",
  "/mynetwork",
  "/jobs",
  "/messaging",
  "/notifications",
];

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function envOr(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v || fallback;
}

function viewportWithJitter(): { width: number; height: number } {
  // Realistic desktop ± small jitter (avoid identical bot fingerprints)
  const baseW = 1365;
  const baseH = 900;
  const j = () => Math.floor(Math.random() * 21) - 10; // -10..+10
  return {
    width: Math.max(1200, baseW + j()),
    height: Math.max(720, baseH + j()),
  };
}

/**
 * Shared launch options for LinkedIn persistent contexts.
 * Prefer headed (`HEADLESS` must be explicitly true). Headless increases detection risk.
 */
export function linkedInContextOptions(headless?: boolean) {
  const resolved =
    headless ??
    (process.env.HEADLESS === "true" || process.env.HEADLESS === "1");
  if (resolved) {
    console.warn(
      "[linkedin-safety] HEADLESS=true — LinkedIn detection risk is higher; prefer headed.",
    );
  }

  const locale = envOr("LI_SAFE_LOCALE", "en-US");
  const acceptLanguage = envOr(
    "LI_SAFE_ACCEPT_LANGUAGE",
    locale.startsWith("en") ? "en-US,en;q=0.9" : `${locale},${locale.split("-")[0]};q=0.9,en;q=0.8`,
  );
  const timezoneId = process.env.LI_SAFE_TIMEZONE?.trim() || undefined;

  return {
    headless: resolved,
    viewport: viewportWithJitter(),
    locale,
    ...(timezoneId ? { timezoneId } : {}),
    userAgent: DEFAULT_UA,
    extraHTTPHeaders: {
      "Accept-Language": acceptLanguage,
    },
    // Reduce obvious automation signals; keep Playwright + real persistent profile.
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
  };
}

export function looksLikeLoginOrChallenge(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const lower = url.toLowerCase();
    return (
      pathname.includes("/login") ||
      pathname.includes("/checkpoint") ||
      lower.includes("/challenge") ||
      lower.includes("captcha") ||
      lower.includes("/authwall") ||
      lower.includes("security-verification") ||
      lower.includes("/check/add-phone") ||
      lower.includes("unusual") ||
      lower.includes("restricted") ||
      lower.includes("account-restricted")
    );
  } catch {
    return false;
  }
}

export function looksLoggedIn(url: string): boolean {
  try {
    const { pathname, hostname } = new URL(url);
    if (!hostname.includes("linkedin.com")) return false;
    if (looksLikeLoginOrChallenge(url)) return false;
    return (
      FEED_URL_HINTS.some((hint) => pathname.startsWith(hint)) ||
      pathname === "/"
    );
  } catch {
    return false;
  }
}

export function hasLiAtCookie(cookies: Cookie[]): boolean {
  return cookies.some(
    (c) =>
      c.name === "li_at" &&
      Boolean(c.value) &&
      String(c.domain || "").includes("linkedin.com"),
  );
}

export async function contextHasLiAt(context: BrowserContext): Promise<boolean> {
  return hasLiAtCookie(await context.cookies());
}

/**
 * True when URL looks authenticated and (preferably) li_at is present.
 * Falls back to URL/nav signals if cookies are still settling.
 */
export async function isAuthenticatedSession(
  page: Page,
  context: BrowserContext,
): Promise<boolean> {
  const url = page.url();
  if (looksLikeLoginOrChallenge(url)) return false;
  if (await contextHasLiAt(context)) return true;
  if (looksLoggedIn(url)) return true;

  const feedNav = page
    .getByRole("navigation")
    .or(page.locator('a[href*="/feed"]'));
  return feedNav.first().isVisible().catch(() => false);
}

/**
 * Navigate to feed and confirm we are not bounced to login.
 * Returns the final URL.
 */
export async function verifyFeedLoads(
  page: Page,
  context: BrowserContext,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; url: string }> {
  await page.goto(LINKEDIN_FEED_URL, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  // Brief settle for Set-Cookie / redirects
  await page.waitForTimeout(1_500);

  const url = page.url();
  const ok =
    !looksLikeLoginOrChallenge(url) &&
    (await isAuthenticatedSession(page, context));
  return { ok, url };
}

type StoredState = {
  cookies?: Cookie[];
  origins?: unknown[];
};

/**
 * Seed a persistent context from auth/linkedin.json.
 * launchPersistentContext does not accept storageState — apply cookies manually.
 */
export async function applyStorageStateFile(
  context: BrowserContext,
  statePath: string = LINKEDIN_STORAGE_STATE,
): Promise<number> {
  if (!fs.existsSync(statePath)) return 0;
  const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as StoredState;
  const cookies = raw.cookies ?? [];
  if (cookies.length === 0) return 0;
  await context.addCookies(cookies);
  return cookies.length;
}

/**
 * Example for later scripts:
 *
 * ```ts
 * import { chromium } from "playwright";
 * import {
 *   LINKEDIN_USER_DATA_DIR,
 *   applyStorageStateFile,
 *   linkedInContextOptions,
 * } from "../lib/auth.js";
 *
 * const context = await chromium.launchPersistentContext(
 *   LINKEDIN_USER_DATA_DIR,
 *   linkedInContextOptions(true),
 * );
 * await applyStorageStateFile(context);
 * ```
 */
