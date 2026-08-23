/**
 * Naukri session paths + launch helpers (separate from LinkedIn profile).
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

/** Dedicated folder for Naukri session artifacts (gitignored via auth/). */
export const NAUKRI_AUTH_DIR = path.join(AUTH_DIR, "naukri");

/** Playwright storage state for Naukri. */
export const NAUKRI_STORAGE_STATE = path.join(NAUKRI_AUTH_DIR, "storage-state.json");

/** Persistent Chromium profile for Naukri (never share with LinkedIn). */
export const NAUKRI_USER_DATA_DIR = path.join(
  projectRoot,
  ".pw-user-data",
  "naukri",
);

export const NAUKRI_HOME_URL = "https://www.naukri.com/";
export const NAUKRI_LOGIN_URL = "https://www.naukri.com/nlogin/login";
export const NAUKRI_MNJ_URL = "https://www.naukri.com/mnjuser/homepage";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function envOr(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v || fallback;
}

function viewportWithJitter(): { width: number; height: number } {
  const baseW = 1365;
  const baseH = 900;
  const j = () => Math.floor(Math.random() * 21) - 10;
  return {
    width: Math.max(1200, baseW + j()),
    height: Math.max(720, baseH + j()),
  };
}

export function naukriContextOptions(headless?: boolean) {
  const resolved =
    headless ??
    (process.env.HEADLESS === "true" || process.env.HEADLESS === "1");
  if (resolved) {
    console.warn(
      "[naukri-safety] HEADLESS=true — detection risk is higher; prefer headed.",
    );
  }

  const locale = envOr("NAUKRI_SAFE_LOCALE", "en-IN");
  const timezoneId =
    process.env.NAUKRI_SAFE_TIMEZONE?.trim() ||
    process.env.LI_SAFE_TIMEZONE?.trim() ||
    "Asia/Kolkata";

  return {
    headless: resolved,
    viewport: viewportWithJitter(),
    locale,
    timezoneId,
    userAgent: DEFAULT_UA,
    extraHTTPHeaders: {
      "Accept-Language": envOr(
        "NAUKRI_SAFE_ACCEPT_LANGUAGE",
        "en-IN,en;q=0.9,hi;q=0.8",
      ),
    },
    // Naukri/Akamai often breaks Chromium HTTP/2 (stream INTERNAL_ERROR /
    // intermittent connection refused). Prefer HTTP/1.1.
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-http2",
    ],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
  };
}

export function looksLikeNaukriLogin(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    /\/nlogin\//i.test(lower) ||
    /login\.naukri\.com/i.test(lower) ||
    /\/nlogin\/login/i.test(lower) ||
    /\/login\.php/i.test(lower)
  );
}

export function looksLikeNaukriLoggedIn(url: string): boolean {
  const lower = url.toLowerCase();
  if (looksLikeNaukriLogin(lower)) return false;
  // Bare homepage is NOT logged-in — public visitors land there too.
  return (
    /naukri\.com/i.test(lower) &&
    (/\/mnjuser\//i.test(lower) ||
      /\/myhome/i.test(lower) ||
      /\/recommendedjobs/i.test(lower) ||
      /\/jobseekerdashboard/i.test(lower) ||
      /\/mnj\//i.test(lower))
  );
}

/** Stronger cookie check — marketing cookies alone do not count. */
export async function contextHasNaukriSession(
  context: BrowserContext,
): Promise<boolean> {
  const cookies = await context.cookies("https://www.naukri.com");
  // Common naukri auth / identity cookies (names vary; keep loose but not "any cookie")
  return cookies.some((c) =>
    /^(ni|nauk_|NK:|_t_ds|SESSION|login|JWT|at|rt)/i.test(c.name) ||
    (/naukri/i.test(c.name) && c.value.length > 8),
  );
}

export async function applyNaukriStorageState(
  context: BrowserContext,
): Promise<void> {
  if (!fs.existsSync(NAUKRI_STORAGE_STATE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(NAUKRI_STORAGE_STATE, "utf8")) as {
      cookies?: Array<{
        name: string;
        value: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: "Strict" | "Lax" | "None";
      }>;
    };
    if (raw.cookies?.length) {
      await context.addCookies(
        raw.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain ?? ".naukri.com",
          path: c.path ?? "/",
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite ?? "Lax",
        })),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[naukri-auth] Could not load storage state: ${msg}`);
  }
}

/**
 * Navigate with retries — Naukri/Akamai intermittently refuses or drops.
 */
export async function gotoNaukriWithRetry(
  page: Page,
  url: string,
  label = "naukri",
  attempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT|ERR_HTTP2|ERR_EMPTY_RESPONSE|net::ERR_/i.test(
          msg,
        );
      console.warn(
        `[naukri] ${label} goto failed (attempt ${i}/${attempts}): ${msg.slice(0, 160)}`,
      );
      if (!retryable || i === attempts) break;
      await page.waitForTimeout(1500 * i);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? `Failed to open ${url}`));
}

/**
 * Verify auth by hitting MNJ homepage (not bare www.naukri.com).
 */
export async function verifyNaukriHome(
  page: Page,
  _context: BrowserContext,
): Promise<{ ok: boolean; url: string }> {
  await gotoNaukriWithRetry(page, NAUKRI_MNJ_URL, "mnj homepage");
  await page.waitForTimeout(1500);
  const url = page.url();
  const ok = !looksLikeNaukriLogin(url) && looksLikeNaukriLoggedIn(url);
  return { ok, url };
}

export function ensureNaukriAuthDirs(): void {
  fs.mkdirSync(NAUKRI_AUTH_DIR, { recursive: true });
  fs.mkdirSync(NAUKRI_USER_DATA_DIR, { recursive: true });
}

export function hasNaukriAuthFiles(): boolean {
  return (
    fs.existsSync(NAUKRI_STORAGE_STATE) ||
    (fs.existsSync(NAUKRI_USER_DATA_DIR) &&
      fs.readdirSync(NAUKRI_USER_DATA_DIR).length > 0)
  );
}
