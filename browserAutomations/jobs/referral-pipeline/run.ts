import "dotenv/config";
import type { JobRunResult } from "../../lib/job-types.js";
import { withSharedLeadBrowsers } from "../../lib/leads/browser-session.js";
import { isReferralDryRun } from "../../lib/referral/env.js";

/**
 * Default chain (connect + follow-up are manual review steps):
 * search-jobs → find-people → draft → export
 */
const PIPELINE_STEPS = [
  "referral-search-jobs",
  "referral-find-people",
  "referral-draft",
  "referral-export",
] as const;

type StepId = (typeof PIPELINE_STEPS)[number];

const BROWSER_STEPS = new Set<StepId>([
  "referral-search-jobs",
  "referral-find-people",
]);

async function invokeStep(stepId: StepId): Promise<JobRunResult> {
  switch (stepId) {
    case "referral-search-jobs":
      return (await import("../referral-search-jobs/run.js")).run();
    case "referral-find-people":
      return (await import("../referral-find-people/run.js")).run();
    case "referral-draft":
      return (await import("../referral-draft/run.js")).run();
    case "referral-export":
      return (await import("../referral-export/run.js")).run();
    default: {
      const _exhaustive: never = stepId;
      throw new Error(`Unknown step: ${_exhaustive}`);
    }
  }
}

function sliceSteps(): StepId[] {
  const from = process.env.REFERRAL_PIPELINE_FROM?.trim() as StepId | undefined;
  const to = process.env.REFERRAL_PIPELINE_TO?.trim() as StepId | undefined;
  let steps = [...PIPELINE_STEPS];
  if (from) {
    const i = steps.indexOf(from);
    if (i < 0) throw new Error(`Unknown REFERRAL_PIPELINE_FROM=${from}`);
    steps = steps.slice(i);
  }
  if (to) {
    const i = steps.indexOf(to);
    if (i < 0) throw new Error(`Unknown REFERRAL_PIPELINE_TO=${to}`);
    steps = steps.slice(0, i + 1);
  }
  return steps;
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isReferralDryRun();
  process.env.REFERRAL_DRY_RUN = dryRun ? "true" : "false";
  process.env.DRY_RUN = dryRun ? "true" : "false";

  const steps = sliceSteps();
  console.log("\n════════════════════════════════════════");
  console.log(" Referral pipeline");
  console.log(` Dry-run: ${dryRun}`);
  console.log(` Steps:   ${steps.join(" → ")}`);
  console.log("════════════════════════════════════════\n");

  const results: { step: string; exitCode: number; message?: string }[] = [];
  const needsBrowsers = steps.some((s) => BROWSER_STEPS.has(s));

  const runSteps = async (): Promise<JobRunResult> => {
    for (const step of steps) {
      console.log(`\n── ▶ ${step} ──\n`);
      const result = await invokeStep(step);
      results.push({
        step,
        exitCode: result.exitCode,
        message: result.message,
      });
      if (result.exitCode !== 0) {
        console.error(
          `\nPipeline stopped at ${step} (exit ${result.exitCode}): ${result.message ?? ""}\n`,
        );
        return {
          exitCode: result.exitCode,
          message: `Failed at ${step}: ${result.message ?? "error"}`,
        };
      }
      if (result.message) console.log(`[ok] ${step}: ${result.message}`);
    }

    console.log("\n── Pipeline summary ──");
    for (const r of results) {
      console.log(`  ✓ ${r.step}${r.message ? ` — ${r.message}` : ""}`);
    }
    console.log(
      `\nRun folder: data/referral/${process.env.REFERRAL_RUN_ID ?? "(see meta.json)"}\n`,
    );
    console.log(
      "Next (optional, review drafts first):\n" +
        "  npm run jobs:run -- referral-send-connect --dry-run\n" +
        "  npm run jobs:run -- referral-followup-accepted --dry-run\n",
    );

    return {
      exitCode: 0,
      message: `Completed ${results.length} steps`,
    };
  };

  if (needsBrowsers) {
    return withSharedLeadBrowsers(() => runSteps(), {
      jobId: "referral-pipeline",
    });
  }
  return runSteps();
}

export { PIPELINE_STEPS };
