import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LINKEDIN_STORAGE_STATE,
  LINKEDIN_USER_DATA_DIR,
} from "./auth.js";
import {
  classifyFailure,
  decideHeal,
  logHealEvent,
  openHealLogger,
  waitForAuthArtifacts,
} from "./heal.js";
import type { JobDefinition, JobModule, JobRunResult } from "./job-types.js";
import {
  ProfileBusyError,
  acquireLinkedInJobLock,
  jobNeedsLinkedInLock,
  releaseLinkedInJobLock,
  safetyStatus,
} from "./linkedin-safety.js";
import { jobEntryPath, requireJob } from "./registry.js";

export type RunJobOptions = {
  /** Force dry-run on/off via job's dryRunEnv (or DRY_RUN) */
  dryRun?: boolean;
  /** Extra env applied for this run only */
  env?: Record<string, string>;
  /** Skip heal wrapper (direct entry) */
  noHeal?: boolean;
};

function applyDryRunEnv(job: JobDefinition, dryRun: boolean | undefined): void {
  if (dryRun === undefined) {
    // Apply defaultDryRun only when the env var is unset
    if (job.run?.defaultDryRun && job.run.dryRunEnv) {
      const key = job.run.dryRunEnv;
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = "true";
      }
    }
    return;
  }
  const key = job.run?.dryRunEnv || "DRY_RUN";
  process.env[key] = dryRun ? "true" : "false";
  // Also set generic DRY_RUN for jobs that read it
  process.env.DRY_RUN = dryRun ? "true" : "false";
}

function validateEnv(job: JobDefinition): string[] {
  const missing: string[] = [];
  for (const spec of job.env) {
    if (!spec.required) continue;
    const v = process.env[spec.name];
    if (v === undefined || v === "") {
      if (spec.default !== undefined && spec.default !== null) {
        process.env[spec.name] = String(spec.default);
      } else {
        missing.push(spec.name);
      }
    }
  }
  return missing;
}

function normalizeResult(
  result: number | JobRunResult | void,
): JobRunResult {
  if (result === undefined || result === null) {
    return { exitCode: 0 };
  }
  if (typeof result === "number") {
    return { exitCode: result };
  }
  return result;
}

async function loadJobModule(job: JobDefinition): Promise<JobModule> {
  const entry = jobEntryPath(job);
  if (!fs.existsSync(entry)) {
    throw new Error(`Job entry not found: ${entry}`);
  }
  const href = pathToFileURL(entry).href;
  const mod = (await import(href)) as JobModule & { default?: JobModule["run"] };
  const run = mod.run ?? mod.default;
  if (typeof run !== "function") {
    throw new Error(
      `Job entry ${entry} must export async function run() (or default).`,
    );
  }
  return { run };
}

async function invokeOnce(job: JobDefinition): Promise<JobRunResult> {
  const mod = await loadJobModule(job);
  try {
    return normalizeResult(await mod.run());
  } catch (err) {
    const failure = classifyFailure(err);
    if (failure.kind === "zero_batch" || failure.kind === "safety_limit") {
      return {
        exitCode: 0,
        softSuccess: true,
        message: failure.message,
      };
    }
    throw err;
  }
}

/**
 * Load job metadata, validate env, run entry with deterministic auto-heal.
 * LinkedIn-touching jobs take an exclusive process lock up front — a second
 * starter exits immediately with a clear message.
 */
export async function runJob(
  jobId: string,
  options: RunJobOptions = {},
): Promise<JobRunResult> {
  const job = requireJob(jobId);

  for (const [k, v] of Object.entries(options.env ?? {})) {
    process.env[k] = v;
  }
  applyDryRunEnv(job, options.dryRun);

  const missing = validateEnv(job);
  if (missing.length > 0) {
    return {
      exitCode: 1,
      message: `Missing required env: ${missing.join(", ")}. See jobs/${job.id}/README.md or .env.example.`,
    };
  }

  if (job.requiresAuth) {
    const hasAuth =
      fs.existsSync(LINKEDIN_STORAGE_STATE) ||
      fs.existsSync(LINKEDIN_USER_DATA_DIR);
    if (!hasAuth) {
      const authCmd = job.heal?.authCommand ?? "auth:linkedin";
      return {
        exitCode: 1,
        message:
          `Missing auth for job "${job.id}". Run \`npm run ${authCmd}\` first.`,
      };
    }
  }

  const takeLinkedInLock = jobNeedsLinkedInLock(job);
  if (takeLinkedInLock) {
    try {
      acquireLinkedInJobLock(job.id);
      const status = safetyStatus();
      const left = (a: keyof typeof status.remaining) =>
        `${a}=${status.remaining[a]}`;
      console.log(
        `[linkedin-lock] Acquired for "${job.id}" (pid=${process.pid}). ` +
          "Other LinkedIn jobs will exit until this finishes.",
      );
      console.log(
        `[linkedin-safety] ${status.date} remaining: ` +
          `${left("search")}, ${left("profile_view")}, ${left("connect")}, ` +
          `${left("invite")}, ${left("message")}, ${left("reaction")} ` +
          `(burst ${status.sessionActionsSinceBreak}/${status.burstThreshold})\n`,
      );
    } catch (err) {
      if (err instanceof ProfileBusyError) {
        console.error(`\n[linkedin-lock] ${err.message}\n`);
        return {
          exitCode: 1,
          message: err.message,
        };
      }
      throw err;
    }
  }

  try {
    if (options.noHeal) {
      return await invokeOnce(job);
    }

    const healLog = openHealLogger(job.id);
    logHealEvent(healLog, {
      type: "heal_session_start",
      jobId: job.id,
      entry: path.relative(process.cwd(), jobEntryPath(job)),
      dryRun: options.dryRun,
    });

    let attempt = 0;
    let lastResult: JobRunResult = { exitCode: 1 };

    try {
      while (true) {
        logHealEvent(healLog, {
          type: "attempt_start",
          jobId: job.id,
          attempt,
        });

        try {
          lastResult = await invokeOnce(job);
          if (lastResult.exitCode === 0) {
            logHealEvent(healLog, {
              type: "attempt_ok",
              jobId: job.id,
              attempt,
              softSuccess: lastResult.softSuccess,
              message: lastResult.message,
            });
            return lastResult;
          }

          // Non-zero without throw — treat message as failure for heal
          const failure = classifyFailure(
            new Error(lastResult.message || `exit ${lastResult.exitCode}`),
          );
          const decision = decideHeal(job, failure, attempt);
          logHealEvent(healLog, {
            type: "heal_decision",
            jobId: job.id,
            attempt,
            kind: failure.kind,
            action: decision.action,
            message: decision.message,
            hint: "hint" in decision ? decision.hint : undefined,
          });

          if (decision.action === "soft_success") {
            return { exitCode: 0, softSuccess: true, message: decision.message };
          }
          if (decision.action === "retry") {
            if (decision.hint) console.warn(`\n[heal] ${decision.hint}\n`);
            if (
              failure.kind === "login_redirect" ||
              failure.kind === "missing_auth"
            ) {
              await waitForAuthArtifacts([
                LINKEDIN_STORAGE_STATE,
                LINKEDIN_USER_DATA_DIR,
              ]);
            }
            attempt += 1;
            continue;
          }

          if (decision.hint) console.error(`\n[heal] ${decision.hint}\n`);
          return {
            exitCode: lastResult.exitCode || 1,
            message: decision.message,
          };
        } catch (err) {
          const failure = classifyFailure(err);
          const decision = decideHeal(job, failure, attempt);
          logHealEvent(healLog, {
            type: "heal_decision",
            jobId: job.id,
            attempt,
            kind: failure.kind,
            action: decision.action,
            message: decision.message,
            hint: "hint" in decision ? decision.hint : undefined,
          });

          if (decision.action === "soft_success") {
            return { exitCode: 0, softSuccess: true, message: decision.message };
          }
          if (decision.action === "retry") {
            if (decision.hint) console.warn(`\n[heal] ${decision.hint}\n`);
            if (
              failure.kind === "login_redirect" ||
              failure.kind === "missing_auth"
            ) {
              await waitForAuthArtifacts([
                LINKEDIN_STORAGE_STATE,
                LINKEDIN_USER_DATA_DIR,
              ]);
            }
            attempt += 1;
            continue;
          }

          if (decision.hint) console.error(`\n[heal] ${decision.hint}\n`);
          return { exitCode: 1, message: decision.message };
        }
      }
    } finally {
      logHealEvent(healLog, {
        type: "heal_session_end",
        jobId: job.id,
        exitCode: lastResult.exitCode,
      });
      await healLog.close();
    }
  } finally {
    if (takeLinkedInLock) {
      releaseLinkedInJobLock();
      console.log(`[linkedin-lock] Released for "${job.id}".\n`);
    }
  }
}
