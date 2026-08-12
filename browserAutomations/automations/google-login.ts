/**
 * Interactive Google / Gmail login — saves a persistent Chromium profile
 * for later outreach email sends.
 *
 *   npm run auth:google
 *
 * Prefer headed mode. Complete 2FA / consent in the browser window.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  AUTH_DIR,
  GMAIL_INBOX_URL,
  GOOGLE_STORAGE_STATE,
  GOOGLE_USER_DATA_DIR,
  googleContextOptions,
  looksLikeGoogleLogin,
  verifyGmailLoads,
} from "../lib/auth-google.js";

const MANUAL_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2_500;

function isHeadless(): boolean {
  return process.env.HEADLESS === "true" || process.env.HEADLESS === "1";
}

function listenForEnter(message: string): {
  promise: Promise<"enter">;
  close: () => void;
} {
  if (!process.stdin.isTTY) {
    return {
      promise: new Promise<"enter">(() => {
        /* never */
      }),
      close: () => undefined,
    };
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const promise = new Promise<"enter">((resolve) => {
    rl.question(`${message}\nPress Enter here when Gmail inbox is open… `, () => {
      resolve("enter");
    });
  });
  return {
    promise,
    close: () => {
      try {
        rl.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function waitUntilGmail(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const enter = listenForEnter(
    "Sign in to Google in the browser (2FA/consent OK).",
  );
  try {
    while (Date.now() < deadline) {
      const raced = await Promise.race([
        enter.promise.then(() => "enter" as const),
        page.waitForTimeout(POLL_INTERVAL_MS).then(() => "tick" as const),
      ]);
      if (raced === "enter") {
        const check = await verifyGmailLoads(page);
        return check.ok;
      }
      const url = page.url();
      if (!looksLikeGoogleLogin(url)) {
        const compose = await page
          .getByRole("button", { name: /compose/i })
          .first()
          .isVisible()
          .catch(() => false);
        if (compose || url.includes("mail.google.com")) {
          return true;
        }
      }
    }
    return false;
  } finally {
    enter.close();
  }
}

async function main(): Promise<void> {
  const headless = isHeadless();
  if (headless) {
    console.warn(
      "HEADLESS=true: Google login usually needs a headed browser for 2FA. Prefer HEADLESS=false.",
    );
  }

  fs.mkdirSync(GOOGLE_USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  console.log("Opening Gmail (persistent Google profile)…");
  let context: BrowserContext;
  const baseOpts = {
    ...googleContextOptions(headless),
    acceptDownloads: true,
  };
  try {
    context = await chromium.launchPersistentContext(GOOGLE_USER_DATA_DIR, {
      ...baseOpts,
      ...(process.env.GOOGLE_USE_CHROME === "false"
        ? {}
        : { channel: "chrome" as const }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/SingletonLock|already in use|user data dir/i.test(message)) {
      console.error(
        "Google profile is already in use. Close other Chromium/Chrome windows using this profile, then retry.",
      );
      process.exit(1);
    }
    // Retry without channel if Chrome channel missing
    context = await chromium.launchPersistentContext(
      GOOGLE_USER_DATA_DIR,
      baseOpts,
    );
  }

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    const existing = await verifyGmailLoads(page).catch(() => ({
      ok: false,
      url: page.url(),
    }));

    if (existing.ok) {
      console.log("Existing Google profile already signed into Gmail.");
    } else {
      await page.goto(GMAIL_INBOX_URL, { waitUntil: "domcontentloaded" });
      console.log(
        "Complete Google sign-in in the open window (email + password + 2FA).",
      );
      const ok = await waitUntilGmail(page, MANUAL_LOGIN_TIMEOUT_MS);
      if (!ok) {
        throw new Error(
          "Gmail login did not complete in time. Run `npm run auth:google` again headed.",
        );
      }
    }

    const verified = await verifyGmailLoads(page);
    if (!verified.ok) {
      throw new Error(
        `Refusing to save Google session — not in Gmail (url=${verified.url}).`,
      );
    }

    await context.storageState({ path: GOOGLE_STORAGE_STATE });
    console.log(
      `Saved Google storage state → ${path.relative(process.cwd(), GOOGLE_STORAGE_STATE)}`,
    );
    console.log(
      `Persistent profile → ${path.relative(process.cwd(), GOOGLE_USER_DATA_DIR)}`,
    );
    console.log(
      "Next: draft outreach, then `npm run jobs:run -- lead-send-outreach --dry-run` (email when address known; else LinkedIn connect).",
    );
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
