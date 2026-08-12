import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  AUTH_DIR,
  LINKEDIN_STORAGE_STATE,
  LINKEDIN_USER_DATA_DIR,
  contextHasLiAt,
  isAuthenticatedSession,
  linkedInContextOptions,
  looksLikeLoginOrChallenge,
  looksLoggedIn,
  verifyFeedLoads,
} from "../lib/auth.js";
import {
  acquireLinkedInJobLock,
  releaseLinkedInJobLock,
} from "../lib/linkedin-safety.js";

const LOGIN_URL = "https://www.linkedin.com/login";
/** How long to wait for 2FA / checkpoint / manual completion (ms). */
const MANUAL_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;

function getCredentials(): { email: string; password: string } {
  const email =
    process.env.LINKEDIN_EMAIL?.trim() || process.env.EMAIL?.trim() || "";
  const password =
    process.env.LINKEDIN_PASSWORD?.trim() || process.env.PASSWORD?.trim() || "";

  if (!email || !password) {
    console.error(
      "Missing credentials. Set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in .env\n" +
        "(or EMAIL / PASSWORD). See .env.example.",
    );
    process.exit(1);
  }

  return { email, password };
}

function isHeadless(): boolean {
  return process.env.HEADLESS === "true" || process.env.HEADLESS === "1";
}

/**
 * Resolves when the user presses Enter, or never if stdin is not a TTY
 * (background agents) — those rely solely on auto-detect.
 */
function listenForEnter(message: string): {
  promise: Promise<"enter">;
  close: () => void;
} {
  if (!process.stdin.isTTY) {
    return {
      promise: new Promise<"enter">(() => {
        /* never resolves without TTY */
      }),
      close: () => undefined,
    };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promise = new Promise<"enter">((resolve) => {
    rl.question(`${message}\nPress Enter here when done (or wait for auto-detect)… `, () => {
      resolve("enter");
    });
  });

  return {
    promise,
    close: () => {
      try {
        rl.close();
      } catch {
        /* already closed */
      }
    },
  };
}

async function fillLoginForm(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_500);

  // Already past login (persistent profile / redirect)
  if (
    !looksLikeLoginOrChallenge(page.url()) &&
    (looksLoggedIn(page.url()) || (await contextHasLiAt(page.context())))
  ) {
    console.log("Already past login page — skipping credential fill.");
    return;
  }

  // Prefer visible fields; LinkedIn sometimes keeps a hidden email input in the DOM.
  const visibleEmail = page
    .locator(
      'input#username, input[autocomplete="username"], input[type="email"], input[name="session_key"]',
    )
    .or(page.getByLabel(/email|phone/i))
    .or(page.getByRole("textbox", { name: /email|phone/i }))
    .filter({ visible: true });

  const visiblePassword = page
    .locator(
      'input#password, input[autocomplete="current-password"], input[type="password"], input[name="session_password"]',
    )
    .or(page.getByLabel(/^password$/i))
    .filter({ visible: true });

  const anyEmail = page.locator(
    'input#username, input[autocomplete="username"], input[type="email"], input[name="session_key"]',
  );
  const anyPassword = page.locator(
    'input#password, input[autocomplete="current-password"], input[type="password"], input[name="session_password"]',
  );

  let emailFilled = false;
  try {
    await visibleEmail.first().waitFor({ state: "visible", timeout: 12_000 });
    await visibleEmail.first().fill(email);
    emailFilled = true;
  } catch {
    // Fall through to force-fill hidden React-controlled inputs
  }

  if (!emailFilled) {
    await anyEmail.first().waitFor({ state: "attached", timeout: 20_000 });
    await anyEmail.first().fill(email, { force: true });
  }

  // Some LinkedIn flows ask for email first, then password on the next step
  let pwdReady = await visiblePassword
    .first()
    .isVisible()
    .catch(() => false);
  if (!pwdReady) {
    const continueBtn = page
      .getByRole("button", { name: /sign in|continue|next/i })
      .filter({ visible: true });
    if (await continueBtn.first().isVisible().catch(() => false)) {
      await continueBtn.first().click();
      await page.waitForTimeout(1_000);
      pwdReady = await visiblePassword
        .first()
        .isVisible()
        .catch(() => false);
    }
  }

  if (pwdReady) {
    await visiblePassword.first().fill(password);
  } else {
    await anyPassword.first().waitFor({ state: "attached", timeout: 20_000 });
    await anyPassword.first().fill(password, { force: true });
  }

  const signIn = page
    .getByRole("button", { name: /sign in/i })
    .or(page.locator('button[type="submit"]'))
    .filter({ visible: true });
  await signIn.first().click();
}

async function waitForLoginOutcome(
  page: Page,
  context: BrowserContext,
): Promise<"success" | "challenge" | "unknown"> {
  try {
    await page.waitForURL(
      (url) =>
        !url.pathname.includes("/login") ||
        looksLikeLoginOrChallenge(url.toString()),
      { timeout: 45_000 },
    );
  } catch {
    // Stay on login or slow network — fall through
  }

  if (await isAuthenticatedSession(page, context)) return "success";
  if (looksLikeLoginOrChallenge(page.url())) return "challenge";
  return "unknown";
}

/**
 * Poll until authenticated (URL off login + preferably li_at), or Enter, or timeout.
 */
async function waitUntilAuthenticated(
  page: Page,
  context: BrowserContext,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const enter = listenForEnter(
    "Complete 2FA / checkpoint in the browser window if prompted.",
  );

  try {
    while (Date.now() < deadline) {
      if (await isAuthenticatedSession(page, context)) {
        return true;
      }

      const raced = await Promise.race([
        enter.promise.then(() => "enter" as const),
        page.waitForTimeout(POLL_INTERVAL_MS).then(() => "tick" as const),
      ]);

      if (raced === "enter") {
        // User signaled done — one more check
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(1_000);
        return isAuthenticatedSession(page, context);
      }
    }
  } finally {
    enter.close();
  }

  return isAuthenticatedSession(page, context);
}

async function ensureLoggedIn(
  page: Page,
  context: BrowserContext,
): Promise<void> {
  let outcome = await waitForLoginOutcome(page, context);

  if (outcome === "success") {
    console.log("Login succeeded.");
    return;
  }

  console.log(
    "\nLinkedIn may require verification (2FA, CAPTCHA, checkpoint, phone, etc.).\n" +
      "Complete the challenge in the open browser window.\n" +
      `Auto-detecting success for up to ${Math.round(MANUAL_LOGIN_TIMEOUT_MS / 60_000)} minutes` +
      (process.stdin.isTTY ? " (or press Enter when on feed)…" : "…"),
  );

  const ok = await waitUntilAuthenticated(
    page,
    context,
    MANUAL_LOGIN_TIMEOUT_MS,
  );

  if (ok) {
    console.log("Session looks authenticated.");
    return;
  }

  if (page.url().includes("/login") || !(await contextHasLiAt(context))) {
    throw new Error(
      "Still not logged in (on /login or missing li_at). Authentication did not complete — try again.",
    );
  }

  if (!looksLoggedIn(page.url()) && looksLikeLoginOrChallenge(page.url())) {
    throw new Error(
      "Still on a login/checkpoint page. Authentication did not complete — try again.",
    );
  }

  console.log(
    "Could not fully confirm feed URL; will verify via feed navigation before saving.",
  );
}

async function saveStorageStateIfAuthenticated(
  page: Page,
  context: BrowserContext,
): Promise<void> {
  console.log("Verifying feed/home loads before saving session…");
  const { ok, url } = await verifyFeedLoads(page, context);

  if (!ok) {
    throw new Error(
      `Refusing to save storage state — not authenticated after feed check (url=${url}).`,
    );
  }

  const hasLiAt = await contextHasLiAt(context);
  if (!hasLiAt) {
    throw new Error(
      "Refusing to save storage state — li_at cookie missing after login. Try again.",
    );
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: LINKEDIN_STORAGE_STATE });
  console.log(
    `Saved storage state → ${path.relative(process.cwd(), LINKEDIN_STORAGE_STATE)} (li_at present)`,
  );
  console.log(
    `Persistent profile → ${path.relative(process.cwd(), LINKEDIN_USER_DATA_DIR)}`,
  );
}

async function main(): Promise<void> {
  const { email, password } = getCredentials();
  const headless = isHeadless();

  if (headless) {
    console.warn(
      "HEADLESS=true: 2FA/CAPTCHA cannot be completed interactively. Prefer headed mode for first login.",
    );
  }

  fs.mkdirSync(LINKEDIN_USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  acquireLinkedInJobLock("auth:linkedin");
  console.log("Opening LinkedIn login (persistent profile)…");
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(
      LINKEDIN_USER_DATA_DIR,
      {
        ...linkedInContextOptions(headless),
        acceptDownloads: true,
      },
    );
  } catch (err) {
    releaseLinkedInJobLock();
    const message = err instanceof Error ? err.message : String(err);
    if (/existing browser session|user data dir|SingletonLock|already in use/i.test(message)) {
      console.error(
        "LinkedIn profile is already in use. Close other Chromium windows using this profile, then retry.",
      );
      process.exit(1);
    }
    throw err;
  }

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    // If profile already has a live session, skip the form
    const existing = await verifyFeedLoads(page, context).catch(() => ({
      ok: false,
      url: page.url(),
    }));

    if (existing.ok && (await contextHasLiAt(context))) {
      console.log("Existing persistent profile already logged in.");
    } else {
      await fillLoginForm(page, email, password);
      await ensureLoggedIn(page, context);
    }

    await saveStorageStateIfAuthenticated(page, context);
    console.log(
      "Later scripts can reuse this session via storageState + persistent profile (see lib/auth.ts).",
    );
  } finally {
    await context.close();
    releaseLinkedInJobLock();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
