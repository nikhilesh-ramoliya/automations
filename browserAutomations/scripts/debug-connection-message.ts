/**
 * Debug script: test messaging one accepted connection.
 * Usage: npx tsx scripts/debug-connection-message.ts [profileUrl] [fullName]
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { draftConnectionMessage } from "../lib/connections/message.js";
import { hasLinkedInAuth, withLinkedInPage } from "../lib/leads/browser.js";
import {
  extractProfileUrn,
  messageAcceptedConnection,
} from "../lib/leads/linkedin-message.js";

const DEBUG_DIR = path.join("logs", "debug-message");

async function snap(page: import("playwright").Page, label: string): Promise<void> {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const safe = label.replace(/[^a-z0-9_-]+/gi, "_");
  await page.screenshot({ path: path.join(DEBUG_DIR, `${safe}.png`), fullPage: false }).catch(() => undefined);
  console.log(`  screenshot → logs/debug-message/${safe}.png`);
}

async function main(): Promise<void> {
  const profileUrl =
    process.argv[2] ?? "https://www.linkedin.com/in/kashish-mahur-27335b318";
  const fullName = process.argv[3] ?? "Kashish";

  if (!hasLinkedInAuth()) {
    console.error("Run npm run auth:linkedin first");
    process.exit(1);
  }

  const message = draftConnectionMessage({ fullName });
  console.log(`\nDebug message to ${fullName}`);
  console.log(`URL: ${profileUrl}`);
  console.log(`Body (${message.length} chars):\n${message}\n`);

  await withLinkedInPage(
    async (page) => {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await snap(page, "01-profile");
      const urn = await extractProfileUrn(page);
      console.log(`Profile URN: ${urn ?? "(not found)"}`);

      const dryRun = process.env.CONNECTION_FOLLOWUP_DRY_RUN !== "false";
      console.log(`dryRun=${dryRun}\n`);

      const res = await messageAcceptedConnection(page, {
        profileUrl,
        message,
        dryRun,
        onlyAccepted: true,
        quickCheck: true,
      });

      await snap(page, "02-after");
      console.log("\nResult:", JSON.stringify(res, null, 2));
    },
    { jobId: "debug-connection-message" },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
