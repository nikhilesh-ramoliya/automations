/**
 * Interactive Naukri login — saves session under auth/naukri/ + .pw-user-data/naukri.
 *
 *   npm run auth:naukri
 *
 * Fixes:
 * - Do not treat bare homepage as "already logged in"
 * - Always fill email/password when session is expired
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium, type Locator, type Page } from "playwright";
import {
  NAUKRI_AUTH_DIR,
  NAUKRI_LOGIN_URL,
  NAUKRI_MNJ_URL,
  NAUKRI_STORAGE_STATE,
  NAUKRI_USER_DATA_DIR,
  applyNaukriStorageState,
  ensureNaukriAuthDirs,
  looksLikeNaukriLogin,
  naukriContextOptions,
} from "../lib/auth-naukri.js";

const MANUAL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2_000;

function getCredentials(): { email: string; password: string } {
  const email =
    process.env.NAUKRI_EMAIL?.trim() ||
    process.env.NAUKRI_USERNAME?.trim() ||
    "";
  const password = process.env.NAUKRI_PASSWORD?.trim() || "";

  if (!email || !password) {
    console.error(
      "Missing credentials. Set NAUKRI_EMAIL and NAUKRI_PASSWORD in .env",
    );
    process.exit(1);
  }
  if (
    /your-email@example\.com|example\.com/i.test(email) ||
    /your-password/i.test(password)
  ) {
    console.error("Replace placeholder Naukri credentials in .env.");
    process.exit(1);
  }
  return { email, password };
}

function isHeadless(): boolean {
  return process.env.HEADLESS === "true" || process.env.HEADLESS === "1";
}

function listenForEnter(message: string): {
  promise: Promise<"enter">;
  close: () => void;
} {
  if (!process.stdin.isTTY) {
    return {
      promise: new Promise<"enter">(() => undefined),
      close: () => undefined,
    };
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    promise: new Promise<"enter">((resolve) => {
      rl.question(
        `${message}\nPress Enter when logged in (or wait for auto-detect)… `,
        () => resolve("enter"),
      );
    }),
    close: () => {
      try {
        rl.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function dismissNoise(page: Page): Promise<void> {
  for (const sel of [
    'button:has-text("Got it")',
    'button:has-text("Maybe later")',
    'button:has-text("Not Now")',
    ".crossIcon",
    '[id*="close"]',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => undefined);
    }
  }
}

async function typeInto(
  page: Page,
  loc: Locator,
  value: string,
  label: string,
): Promise<void> {
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  await loc.click({ force: true });
  await page.waitForTimeout(150);
  await loc.fill("");
  try {
    await loc.pressSequentially(value, { delay: 40 });
  } catch {
    await loc.fill(value, { force: true });
  }
  let current = await loc.inputValue().catch(() => "");
  if (!current) {
    await loc.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    current = await loc.inputValue().catch(() => "");
  }
  if (!current) {
    throw new Error(`Could not fill Naukri ${label} field`);
  }
  console.log(`  ✓ Filled ${label}`);
}

async function findInPageOrFrames(
  page: Page,
  selectors: string[],
  timeoutMs = 20_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const onPage = page.locator(sel).first();
      if (await onPage.isVisible().catch(() => false)) return onPage;
    }
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      for (const sel of selectors) {
        try {
          const loc = frame.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) return loc;
        } catch {
          /* cross-origin / detached */
        }
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function fillLoginForm(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  console.log("Opening Naukri login page…");
  await page.goto(NAUKRI_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(2500);
  await dismissNoise(page);

  // Open login drawer if fields not visible yet
  const fieldVisible = await page
    .locator("input#usernameField, input[type='password']")
    .first()
    .isVisible()
    .catch(() => false);
  if (!fieldVisible) {
    for (const sel of [
      "#login_Layer",
      "a#login_Layer",
      "a[title='Jobseeker Login']",
      "div.nI-gNb-lg-ic",
      "a:has-text('Login')",
    ]) {
      const t = page.locator(sel).first();
      if (await t.isVisible({ timeout: 700 }).catch(() => false)) {
        console.log(`  Clicking ${sel} to open login…`);
        await t.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(1500);
        break;
      }
    }
  }

  const emailInput = await findInPageOrFrames(page, [
    "input#usernameField",
    'input[placeholder*="Email ID" i]',
    'input[placeholder*="Email" i]',
    'input[placeholder*="Username" i]',
    'input[name="email"]',
    'input[name="USERNAME"]',
    'input[type="email"]',
    "input#eLoginNew",
  ]);

  if (!emailInput) {
    const shot = path.join(NAUKRI_AUTH_DIR, "login-debug.png");
    await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    throw new Error(
      `Email field not found. Screenshot: ${shot}\n` +
        "Log in manually in the browser, then re-run or press Enter when on MNJ home.",
    );
  }

  console.log("  Filling email…");
  await typeInto(page, emailInput, email, "email");

  let passwordInput = await findInPageOrFrames(
    page,
    [
      "input#passwordField",
      'input[type="password"]',
      "input#pLogin",
      'input[name="PASSWORD"]',
      'input[name="password"]',
    ],
    10_000,
  );

  if (!passwordInput) {
    const next = page.getByRole("button", { name: /continue|next|login/i }).first();
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(1200);
    }
    passwordInput = await findInPageOrFrames(page, [
      "input#passwordField",
      'input[type="password"]',
    ]);
  }

  if (!passwordInput) {
    throw new Error("Password field not found on Naukri login.");
  }

  console.log("  Filling password…");
  await typeInto(page, passwordInput, password, "password");

  const loginBtn =
    (await findInPageOrFrames(
      page,
      [
        'button[type="submit"]',
        "button.blue-btn",
        "button.loginButton",
        'button:has-text("Login")',
        'button:has-text("Sign in")',
      ],
      8_000,
    )) ?? page.getByRole("button", { name: /^login$/i }).first();

  if (!(await loginBtn.isVisible().catch(() => false))) {
    throw new Error("Login button not found.");
  }

  console.log("  Clicking Login…");
  await loginBtn.click();
}

async function isAuthenticated(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (looksLikeNaukriLogin(url)) return false;
  return (
    /\/mnjuser\//i.test(url) ||
    /\/myhome/i.test(url) ||
    /\/recommendedjobs/i.test(url) ||
    /\/jobseekerdashboard/i.test(url) ||
    /\/mnj\//i.test(url)
  );
}

async function waitUntilAuthenticated(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const enter = listenForEnter(
    "Complete OTP / CAPTCHA in the browser if prompted.",
  );
  try {
    while (Date.now() < deadline) {
      if (await isAuthenticated(page)) return true;
      const raced = await Promise.race([
        enter.promise.then(() => "enter" as const),
        page.waitForTimeout(POLL_MS).then(() => "tick" as const),
      ]);
      if (raced === "enter") {
        await page
          .goto(NAUKRI_MNJ_URL, {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          })
          .catch(() => undefined);
        await page.waitForTimeout(1000);
        return isAuthenticated(page);
      }
    }
  } finally {
    enter.close();
  }
  return isAuthenticated(page);
}

async function probeExistingSession(page: Page): Promise<boolean> {
  console.log("Checking session via MNJ homepage (not bare naukri.com)…");
  await page.goto(NAUKRI_MNJ_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);
  if (looksLikeNaukriLogin(page.url())) {
    console.log("  Not logged in (redirected to login).");
    return false;
  }
  if (await isAuthenticated(page)) {
    console.log("  Existing session is valid.");
    return true;
  }
  console.log(`  Not authenticated (url=${page.url()}).`);
  return false;
}

async function main(): Promise<void> {
  const { email, password } = getCredentials();
  ensureNaukriAuthDirs();

  console.log("\nNaukri login");
  console.log(`  Email   → ${email}`);
  console.log(`  Profile → ${NAUKRI_USER_DATA_DIR}`);
  console.log(`  State   → ${NAUKRI_STORAGE_STATE}\n`);

  const context = await chromium.launchPersistentContext(NAUKRI_USER_DATA_DIR, {
    ...naukriContextOptions(isHeadless()),
    acceptDownloads: true,
  });
  await applyNaukriStorageState(context);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    let loggedIn = await probeExistingSession(page);

    if (!loggedIn) {
      await fillLoginForm(page, email, password);
      await page.waitForTimeout(3500);

      await page
        .goto(NAUKRI_MNJ_URL, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        })
        .catch(() => undefined);
      await page.waitForTimeout(1500);

      loggedIn = await isAuthenticated(page);
      if (!loggedIn) {
        console.log(
          "\nOTP / CAPTCHA may be required.\n" +
            "Finish it in the browser, then wait or press Enter.\n" +
            `Waiting up to ${Math.round(MANUAL_TIMEOUT_MS / 60_000)} minutes…\n`,
        );
        loggedIn = await waitUntilAuthenticated(page, MANUAL_TIMEOUT_MS);
      }
    }

    if (!loggedIn) {
      await page.goto(NAUKRI_MNJ_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(2000);
      loggedIn = await isAuthenticated(page);
    }

    if (!loggedIn || looksLikeNaukriLogin(page.url())) {
      throw new Error(
        "Still not logged in. Complete login in the browser and re-run `npm run auth:naukri`.",
      );
    }

    await context.storageState({ path: NAUKRI_STORAGE_STATE });
    fs.writeFileSync(
      path.join(NAUKRI_AUTH_DIR, "session-meta.json"),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          url: page.url(),
        },
        null,
        2,
      ) + "\n",
    );

    console.log("\n✓ Naukri session saved.");
    console.log(`  ${NAUKRI_STORAGE_STATE}\n`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
