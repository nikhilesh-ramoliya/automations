/**
 * Job entry stub — copy this folder to jobs/<your-job-id>/ and rename.
 * Export `run()` returning `{ exitCode }` (or throw for runner heal).
 */
import type { JobRunResult } from "../../lib/job-types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun =
    process.env.DRY_RUN === undefined ||
    process.env.DRY_RUN === "" ||
    process.env.DRY_RUN === "true" ||
    process.env.DRY_RUN === "1";

  console.log(`Template job running (dryRun=${dryRun}). Replace this stub.`);
  return { exitCode: 0 };
}
