import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import { hasLinkedInAuth, withLinkedInPage } from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import {
  isReferralDryRun,
  referralDelayMs,
  referralGeos,
  referralJdKeywords,
  referralMaxJobs,
  referralRoles,
  snapshotConfigFromEnv,
} from "../../lib/referral/env.js";
import {
  artifactPath,
  ensureRunMeta,
  resolveRunDir,
  writeJson,
} from "../../lib/referral/io.js";
import { searchAllJobs } from "../../lib/referral/jobs-search.js";
import { ARTIFACTS } from "../../lib/referral/types.js";
import type { JobPosting } from "../../lib/referral/types.js";
import { SafetyLimitError } from "../../lib/linkedin-safety.js";

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "referral-search-jobs",
    });
  }

  const dryRun = isReferralDryRun();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir({ createIfMissing: true });
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("referral-search-jobs");
  const writer = createJsonlLogger(logPath);

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "LinkedIn session missing. Run `npm run auth:linkedin`.",
    };
  }

  const roles = referralRoles();
  const geos = referralGeos();
  const keywords = referralJdKeywords();
  const maxJobs = referralMaxJobs();
  const delayMs = referralDelayMs();

  console.log(
    `\nReferral job search (run ${runId}, dryRun=${dryRun})\n` +
      `  roles: ${roles.join(" | ")}\n` +
      `  geos:  ${geos.join(" | ")}\n` +
      `  JD keywords (any): ${keywords.join(", ")}\n` +
      `  maxJobs: ${maxJobs}\n`,
  );

  let jobs: JobPosting[] = [];
  let hitCap = false;

  try {
    await withLinkedInPage(
      async (page) => {
        jobs = await searchAllJobs(page, {
          roles,
          geos,
          jdKeywords: keywords,
          maxJobs,
          delayMs,
        });
      },
      { jobId: "referral-search-jobs" },
    );
  } catch (err) {
    if (err instanceof SafetyLimitError) {
      hitCap = true;
      console.warn(`Safety limit: ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      await writer.close();
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.jobs), jobs);
  ensureRunMeta(runDir, runId, config, "referral-search-jobs");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    count: jobs.length,
    dryRun,
    hitCap,
  });

  console.log(`\nMatched ${jobs.length} jobs → data/referral/${runId}/${ARTIFACTS.jobs}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (jobs.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: hitCap
        ? "Safety cap hit before matches."
        : "No jobs matched role/geo/JD keywords.",
    };
  }

  return {
    exitCode: 0,
    softSuccess: hitCap,
    message: `Found ${jobs.length} matching jobs`,
  };
}
