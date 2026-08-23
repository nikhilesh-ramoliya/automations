/**
 * Verify chatbot questionnaire fill on one job URL.
 * Usage: npx tsx scripts/probe-naukri-questionnaire.ts [jobUrl]
 */
import "dotenv/config";
import { withNaukriPage } from "../lib/naukri/browser.js";
import { applyToNaukriJob } from "../lib/naukri/apply.js";

const JOB_URL =
  process.argv[2] ||
  "https://www.naukri.com/job-listings-full-stack-developer-saraca-solutions-bengaluru-3-to-5-years-210826028103";

async function main() {
  const dryRun = process.env.NAUKRI_PROBE_LIVE !== "true";
  console.log(`Probe apply dryRun=${dryRun} url=${JOB_URL}`);
  await withNaukriPage(
    async (page) => {
      const result = await applyToNaukriJob(page, {
        jobUrl: JOB_URL,
        dryRun,
        skipExternal: true,
      });
      console.log("Result:", result);
      await page.waitForTimeout(3000);
    },
    { jobId: "naukri-probe-q", headless: false },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
