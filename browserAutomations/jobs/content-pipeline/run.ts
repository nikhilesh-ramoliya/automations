import "dotenv/config";
import type { JobRunResult } from "../../lib/job-types.js";
import { isContentDryRun } from "../../lib/content/env.js";

/**
 * LinkedIn content engine (offline):
 * research topics → generate & score drafts
 *
 * Never publishes. Review output/content/<runId>/drafts.txt manually.
 */
const PIPELINE_STEPS = [
  "content-research-topics",
  "content-generate-posts",
  "content-compose-draft",
] as const;

type StepId = (typeof PIPELINE_STEPS)[number];

async function invokeStep(stepId: StepId): Promise<JobRunResult> {
  switch (stepId) {
    case "content-research-topics":
      return (await import("../content-research-topics/run.js")).run();
    case "content-generate-posts":
      return (await import("../content-generate-posts/run.js")).run();
    case "content-compose-draft":
      return (await import("../content-compose-draft/run.js")).run();
    default: {
      const _exhaustive: never = stepId;
      throw new Error(`Unknown step: ${_exhaustive}`);
    }
  }
}

function sliceSteps(): StepId[] {
  const from = process.env.CONTENT_PIPELINE_FROM?.trim() as StepId | undefined;
  const to = process.env.CONTENT_PIPELINE_TO?.trim() as StepId | undefined;
  let steps = [...PIPELINE_STEPS];
  if (from) {
    const i = steps.indexOf(from);
    if (i < 0) throw new Error(`Unknown CONTENT_PIPELINE_FROM=${from}`);
    steps = steps.slice(i);
  }
  if (to) {
    const i = steps.indexOf(to);
    if (i < 0) throw new Error(`Unknown CONTENT_PIPELINE_TO=${to}`);
    steps = steps.slice(0, i + 1);
  }
  return steps;
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isContentDryRun();
  process.env.CONTENT_DRY_RUN = dryRun ? "true" : "false";
  process.env.DRY_RUN = dryRun ? "true" : "false";

  const steps = sliceSteps();
  console.log("\n════════════════════════════════════════");
  console.log(" Content pipeline (LinkedIn drafts)");
  console.log(
    dryRun
      ? " Mode: dry-run (writes drafts; never publishes)"
      : " Mode: live flags on (still never auto-publishes)",
  );
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

  console.log("\n════════════════════════════════════════");
  console.log(" Content pipeline complete");
  for (const r of results) {
    console.log(
      `  ${r.exitCode === 0 ? "✓" : "✗"} ${r.step}${r.message ? ` — ${r.message}` : ""}`,
    );
  }
  console.log("════════════════════════════════════════\n");

  const failed = results.find((r) => r.exitCode !== 0);
  return {
    exitCode: failed?.exitCode ?? 0,
    message: failed?.message ?? `completed ${results.length} steps`,
  };
}
