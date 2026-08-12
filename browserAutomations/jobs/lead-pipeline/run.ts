import "dotenv/config";
import type { JobRunResult } from "../../lib/job-types.js";
import { withSharedLeadBrowsers } from "../../lib/leads/browser-session.js";
import { isLeadDryRun } from "../../lib/leads/env.js";

/**
 * Recommended chain (also documented in AGENTS.md):
 * discover → dedupe → enrich → tech-signals → find-decision-makers →
 * suppress → verify-contact → qualify → draft-outreach → export
 */
const PIPELINE_STEPS = [
  "lead-discover-companies",
  "lead-dedupe",
  "lead-enrich-company",
  "lead-tech-signals",
  "lead-find-decision-makers",
  "lead-suppress",
  "lead-verify-contact",
  "lead-qualify",
  "lead-draft-outreach",
  "lead-export",
] as const;

type StepId = (typeof PIPELINE_STEPS)[number];

/** Steps that may open LinkedIn or web Chromium — share one session across these. */
const BROWSER_STEPS = new Set<StepId>([
  "lead-discover-companies",
  "lead-enrich-company",
  "lead-tech-signals",
  "lead-find-decision-makers",
]);

async function invokeStep(stepId: StepId): Promise<JobRunResult> {
  switch (stepId) {
    case "lead-discover-companies":
      return (await import("../lead-discover-companies/run.js")).run();
    case "lead-dedupe":
      return (await import("../lead-dedupe/run.js")).run();
    case "lead-enrich-company":
      return (await import("../lead-enrich-company/run.js")).run();
    case "lead-tech-signals":
      return (await import("../lead-tech-signals/run.js")).run();
    case "lead-find-decision-makers":
      return (await import("../lead-find-decision-makers/run.js")).run();
    case "lead-suppress":
      return (await import("../lead-suppress/run.js")).run();
    case "lead-verify-contact":
      return (await import("../lead-verify-contact/run.js")).run();
    case "lead-qualify":
      return (await import("../lead-qualify/run.js")).run();
    case "lead-draft-outreach":
      return (await import("../lead-draft-outreach/run.js")).run();
    case "lead-export":
      return (await import("../lead-export/run.js")).run();
    default: {
      const _exhaustive: never = stepId;
      throw new Error(`Unknown step: ${_exhaustive}`);
    }
  }
}

function sliceSteps(): StepId[] {
  const from = process.env.LEAD_PIPELINE_FROM?.trim() as StepId | undefined;
  const to = process.env.LEAD_PIPELINE_TO?.trim() as StepId | undefined;
  let steps = [...PIPELINE_STEPS];
  if (from) {
    const i = steps.indexOf(from);
    if (i < 0) throw new Error(`Unknown LEAD_PIPELINE_FROM=${from}`);
    steps = steps.slice(i);
  }
  if (to) {
    const i = steps.indexOf(to);
    if (i < 0) throw new Error(`Unknown LEAD_PIPELINE_TO=${to}`);
    steps = steps.slice(0, i + 1);
  }
  return steps;
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isLeadDryRun();
  // Ensure child jobs see the same dry-run flag
  process.env.LEAD_DRY_RUN = dryRun ? "true" : "false";
  process.env.DRY_RUN = dryRun ? "true" : "false";

  const steps = sliceSteps();
  console.log("\n════════════════════════════════════════");
  console.log(" Lead pipeline");
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
      `\nRun folder: data/leads/${process.env.LEAD_RUN_ID ?? "(see meta.json)"}\n`,
    );

    return {
      exitCode: 0,
      message: `Completed ${results.length} steps`,
    };
  };

  if (needsBrowsers) {
    return withSharedLeadBrowsers(() => runSteps(), {
      jobId: "lead-pipeline",
    });
  }
  return runSteps();
}

export { PIPELINE_STEPS };
