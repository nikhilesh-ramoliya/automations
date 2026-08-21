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
  referralMaxPeoplePerCompany,
  referralMaxRecruitersPerCompany,
  snapshotConfigFromEnv,
} from "../../lib/referral/env.js";
import {
  artifactPath,
  ensureRunMeta,
  loadJobs,
  resolveRunDir,
  writeJson,
} from "../../lib/referral/io.js";
import {
  companiesFromJobs,
  findPeopleForCompany,
} from "../../lib/referral/people.js";
import { ARTIFACTS, type ReferralPerson } from "../../lib/referral/types.js";
import { SafetyLimitError, humanDelay } from "../../lib/linkedin-safety.js";

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "referral-find-people",
    });
  }

  const dryRun = isReferralDryRun();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("referral-find-people");
  const writer = createJsonlLogger(logPath);

  const jobs = loadJobs(runDir);
  if (jobs.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.people), []);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No jobs — run referral-search-jobs first.",
    };
  }

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "LinkedIn session missing. Run `npm run auth:linkedin`.",
    };
  }

  const companies = companiesFromJobs(jobs);
  const maxPer = referralMaxPeoplePerCompany();
  const maxRecruiters = referralMaxRecruitersPerCompany();
  const delayMs = referralDelayMs();

  console.log(
    `\nFind people for ${companies.length} companies (run ${runId}, dryRun=${dryRun})\n` +
      `  max/company=${maxPer}, max recruiters=${maxRecruiters}\n`,
  );

  const people: ReferralPerson[] = [];
  const seen = new Set<string>();
  let hitCap = false;

  try {
    await withLinkedInPage(
      async (page) => {
        for (const company of companies) {
          try {
            const batch = await findPeopleForCompany(page, company, {
              maxTotal: maxPer,
              maxRecruiters,
              delayMs,
            });
            for (const p of batch) {
              const key = p.linkedinUrl.toLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              people.push(p);
              writer.log({
                ts: new Date().toISOString(),
                type: "person",
                ...p,
              });
            }
            console.log(
              `  → ${company.companyName}: ${batch.length} people`,
            );
            await humanDelay("between_companies");
          } catch (err) {
            if (err instanceof SafetyLimitError) {
              hitCap = true;
              console.warn(`Safety limit: ${err.message}`);
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`  people failed for ${company.companyName}: ${msg}`);
            if (/login|checkpoint|restriction/i.test(msg)) throw err;
          }
        }
      },
      { jobId: "referral-find-people" },
    );
  } catch (err) {
    if (err instanceof SafetyLimitError) {
      hitCap = true;
      console.warn(`Safety limit: ${err.message}`);
    } else {
      throw err;
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.people), people);
  ensureRunMeta(runDir, runId, config, "referral-find-people");

  console.log(
    `\nFound ${people.length} people → data/referral/${runId}/${ARTIFACTS.people}`,
  );
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (people.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: hitCap
        ? "Safety cap hit; no people found."
        : "No recruiters/peers found for job companies.",
    };
  }

  return {
    exitCode: 0,
    softSuccess: hitCap,
    message: `Found ${people.length} people across ${companies.length} companies`,
  };
}
