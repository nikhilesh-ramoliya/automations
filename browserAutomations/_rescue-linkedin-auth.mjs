import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { AUTH_DIR, LINKEDIN_STORAGE_STATE } from "./lib/auth.js";

const udir = process.argv[2];
if (!udir || !fs.existsSync(udir)) {
  console.error("Missing profile dir", udir);
  process.exit(1);
}
fs.mkdirSync(AUTH_DIR, { recursive: true });
const context = await chromium.launchPersistentContext(udir, {
  headless: true,
  viewport: { width: 1280, height: 720 },
});
try {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2000);
  const url = page.url();
  console.log("URL_HOST_PATH=" + new URL(url).hostname + new URL(url).pathname);
  const loggedIn = !url.includes("/login") && !url.includes("/checkpoint") && url.includes("linkedin.com");
  console.log("LOOKS_LOGGED_IN=" + loggedIn);
  await context.storageState({ path: LINKEDIN_STORAGE_STATE });
  const st = fs.statSync(LINKEDIN_STORAGE_STATE);
  console.log("SAVED path=auth/linkedin.json bytes=" + st.size);
} finally {
  await context.close();
}
