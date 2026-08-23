import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import { applyToNaukriJob } from "../../lib/naukri/apply.js";
import { hasNaukriAuth, withNaukriPage } from "../../lib/naukri/browser.js";
import {
  isNaukriDryRun,
  naukriApplyMax,
  naukriSkipExternalApply,
  snapshotConfigFromEnv,
} from "../../lib/naukri/env.js";
import {
  artifactPath,
  ensureRunMeta,
  loadJobs,
  readJson,
  resolveRunDir,
  writeJson,
} from "../../lib/naukri/io.js";
import {
  NaukriSafetyLimitError,
  naukriDelay,
  remainingCap,
} from "../../lib/naukri/safety.js";
import {
  ARTIFACTS,
  type NaukriApplyResult,
} from "../../lib/naukri/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isNaukriDryRun();
  const max = naukriApplyMax();
  const skipExternal = naukriSkipExternalApply();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("naukri-apply");
  const writer = createJsonlLogger(logPath);

  const jobs = loadJobs(runDir);
  const prior =
    readJson<NaukriApplyResult[]>(
      artifactPath(runDir, ARTIFACTS.applied),
    ) ?? [];
  const alreadyOk = new Set(
    prior
      .filter((r) => r.ok && !r.dryRun && r.action === "naukri_apply")
      .map((r) => r.jobId),
  );

  const candidates = jobs.filter((j) => !alreadyOk.has(j.id));
  if (candidates.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.applied), prior);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No jobs to apply — run naukri-search-jobs first, or all done.",
    };
  }

  if (!hasNaukriAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "Naukri session missing. Run `npm run auth:naukri`.",
    };
  }

  const applyLeft = remainingCap("apply");
  const batchCap = Math.min(max, candidates.length, Math.max(0, applyLeft));
  if (batchCap === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.applied), prior);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: `Apply daily cap reached (remaining=${applyLeft}).`,
    };
  }

  const batch = candidates.slice(0, batchCap);
  const results: NaukriApplyResult[] = [...prior];
  const now = new Date().toISOString();
  let hitCap = false;

  console.log(
    `\nNaukri apply: up to ${batch.length} (run ${runId}, dryRun=${dryRun}, skipExternal=${skipExternal})\n`,
  );

  try {
    await withNaukriPage(
      async (page) => {
        for (const job of batch) {
          try {
            const res = await applyToNaukriJob(page, {
              jobUrl: job.jobUrl,
              dryRun,
              skipExternal,
            });
            const row: NaukriApplyResult = {
              jobId: job.id,
              title: job.title,
              companyName: job.companyName,
              jobUrl: job.jobUrl,
              action: res.ok
                ? res.action
                : res.action === "skip"
                  ? "skip"
                  : "error",
              dryRun,
              ok: res.ok,
              detail: res.detail,
              appliedAt: now,
            };
            results.push(row);
            writer.log({ ts: now, type: "apply", ...row });
            console.log(
              `  ${res.ok ? "✓" : "✗"} ${job.title} @ ${job.companyName} → ${row.action} (${row.detail ?? ""})`,
            );
          } catch (err) {
            if (err instanceof NaukriSafetyLimitError) {
              hitCap = true;
              console.warn(`Safety: ${err.message}`);
              results.push({
                jobId: job.id,
                title: job.title,
                companyName: job.companyName,
                jobUrl: job.jobUrl,
                action: "skip",
                dryRun,
                ok: false,
                detail: err.message,
                appliedAt: now,
              });
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            results.push({
              jobId: job.id,
              title: job.title,
              companyName: job.companyName,
              jobUrl: job.jobUrl,
              action: "error",
              dryRun,
              ok: false,
              detail: msg,
              appliedAt: now,
            });
            if (/login/i.test(msg)) throw err;
          }
          await naukriDelay("between");
        }
      },
      { jobId: "naukri-apply" },
    );
  } catch (err) {
    if (err instanceof NaukriSafetyLimitError) {
      hitCap = true;
      console.warn(`Safety: ${err.message}`);
    } else {
      throw err;
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.applied), results);
  ensureRunMeta(runDir, runId, config, "naukri-apply");

  const thisRun = results.slice(prior.length);
  const okN = thisRun.filter((r) => r.ok).length;
  console.log(`\nApply summary: ok=${okN}/${thisRun.length} (dryRun=${dryRun})`);
  console.log(`→ data/naukri/${runId}/${ARTIFACTS.applied}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  return {
    exitCode: 0,
    softSuccess: hitCap,
    message: `Applied batch ${thisRun.length}: ok=${okN}`,
  };
}
