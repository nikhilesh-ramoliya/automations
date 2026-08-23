import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import { hasNaukriAuth, withNaukriPage } from "../../lib/naukri/browser.js";
import {
  envBool,
  isNaukriDryRun,
  naukriDelayMs,
  naukriGeos,
  naukriKeywords,
  naukriMaxJobs,
  naukriRoles,
  snapshotConfigFromEnv,
} from "../../lib/naukri/env.js";
import {
  artifactPath,
  ensureRunMeta,
  resolveRunDir,
  writeJson,
} from "../../lib/naukri/io.js";
import { searchAllJobs } from "../../lib/naukri/jobs-search.js";
import { NaukriSafetyLimitError } from "../../lib/naukri/safety.js";
import { ARTIFACTS, type NaukriJob } from "../../lib/naukri/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isNaukriDryRun();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir({ createIfMissing: true });
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("naukri-search-jobs");
  const writer = createJsonlLogger(logPath);

  if (!hasNaukriAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "Naukri session missing. Run `npm run auth:naukri`.",
    };
  }

  const roles = naukriRoles();
  const geos = naukriGeos();
  const keywords = naukriKeywords();
  const maxJobs = naukriMaxJobs();
  const delayMs = naukriDelayMs();
  const openDetails = envBool("NAUKRI_OPEN_JOB_DETAILS", false);

  console.log(
    `\nNaukri job search (run ${runId}, dryRun=${dryRun})\n` +
      `  roles: ${roles.join(" | ")}\n` +
      `  geos:  ${geos.join(" | ")}\n` +
      `  keywords (any): ${keywords.join(", ")}\n` +
      `  maxJobs: ${maxJobs}\n`,
  );

  let jobs: NaukriJob[] = [];
  let hitCap = false;

  try {
    await withNaukriPage(
      async (page) => {
        jobs = await searchAllJobs(page, {
          roles,
          geos,
          keywords,
          maxJobs,
          delayMs,
          openDetails,
        });
      },
      { jobId: "naukri-search-jobs" },
    );
  } catch (err) {
    if (err instanceof NaukriSafetyLimitError) {
      hitCap = true;
      console.warn(`Safety limit: ${err.message}`);
    } else {
      await writer.close();
      throw err;
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.jobs), jobs);
  ensureRunMeta(runDir, runId, config, "naukri-search-jobs");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    count: jobs.length,
    dryRun,
    hitCap,
  });

  console.log(
    `\nMatched ${jobs.length} jobs → data/naukri/${runId}/${ARTIFACTS.jobs}`,
  );
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (jobs.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: hitCap
        ? "Safety cap hit before matches."
        : "No jobs matched role/geo/keywords.",
    };
  }

  return {
    exitCode: 0,
    softSuccess: hitCap,
    message: `Found ${jobs.length} matching jobs`,
  };
}
