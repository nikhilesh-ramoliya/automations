import { defineConfig, devices } from "@playwright/test";

/**
 * Shared Playwright defaults for scripts and future tests.
 * Login flows run headed by default via automations/*.ts (not this config alone).
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    headless: !!process.env.CI,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
});
