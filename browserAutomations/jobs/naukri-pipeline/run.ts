import "dotenv/config";
import type { JobRunResult } from "../../lib/job-types.js";
import { envBool, isNaukriDryRun } from "../../lib/naukri/env.js";

/**
 * Default: search → export → apply.
 * Skip apply with NAUKRI_PIPELINE_SKIP_APPLY=true
 */
const PIPELINE_STEPS = [
  "naukri-search-jobs",
  "naukri-export",
  "naukri-apply",
] as const;

type StepId = (typeof PIPELINE_STEPS)[number];

async function invokeStep(stepId: StepId): Promise<JobRunResult> {
  switch (stepId) {
    case "naukri-search-jobs":
      return (await import("../naukri-search-jobs/run.js")).run();
    case "naukri-export":
      return (await import("../naukri-export/run.js")).run();
    case "naukri-apply":
      return (await import("../naukri-apply/run.js")).run();
    default: {
      const _exhaustive: never = stepId;
      throw new Error(`Unknown step: ${_exhaustive}`);
    }
  }
}

function sliceSteps(): StepId[] {
  const from = process.env.NAUKRI_PIPELINE_FROM?.trim() as StepId | undefined;
  const to = process.env.NAUKRI_PIPELINE_TO?.trim() as StepId | undefined;
  let steps = [...PIPELINE_STEPS];

  if (envBool("NAUKRI_PIPELINE_SKIP_APPLY", false)) {
    steps = steps.filter((s) => s !== "naukri-apply");
  }

  if (from) {
    const i = steps.indexOf(from);
    if (i < 0) throw new Error(`Unknown NAUKRI_PIPELINE_FROM=${from}`);
    steps = steps.slice(i);
  }
  if (to) {
    const i = steps.indexOf(to);
    if (i < 0) throw new Error(`Unknown NAUKRI_PIPELINE_TO=${to}`);
    steps = steps.slice(0, i + 1);
  }
  return steps;
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isNaukriDryRun();
  process.env.NAUKRI_DRY_RUN = dryRun ? "true" : "false";
  process.env.DRY_RUN = dryRun ? "true" : "false";

  const steps = sliceSteps();
  console.log("\n════════════════════════════════════════");
  console.log(" Naukri pipeline");
  console.log(` Dry-run: ${dryRun}`);
  console.log(` Steps:   ${steps.join(" → ")}`);
  console.log("════════════════════════════════════════\n");

  const results: { step: string; exitCode: number; message?: string }[] = [];

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
    `\nRun folder: data/naukri/${process.env.NAUKRI_RUN_ID ?? "(see meta.json)"}\n`,
  );

  return {
    exitCode: 0,
    message: `Completed ${results.length} steps`,
  };
}

export { PIPELINE_STEPS };
