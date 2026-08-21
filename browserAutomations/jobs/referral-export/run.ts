import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  isReferralDryRun,
  snapshotConfigFromEnv,
} from "../../lib/referral/env.js";
import {
  ensureRunMeta,
  loadJobs,
  loadTargets,
  resolveOutputDir,
  resolveRunDir,
  writeJson,
} from "../../lib/referral/io.js";
import { ARTIFACTS } from "../../lib/referral/types.js";

function csvEscape(value: string | number | boolean | undefined | null): string {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function jobsCsv(
  jobs: ReturnType<typeof loadJobs>,
): string {
  const headers = [
    "jobId",
    "title",
    "companyName",
    "location",
    "geo",
    "roleQuery",
    "matchedKeywords",
    "jobUrl",
    "companyLinkedInUrl",
  ];
  const lines = [headers.join(",")];
  for (const j of jobs) {
    lines.push(
      [
        j.id,
        j.title,
        j.companyName,
        j.location,
        j.geo,
        j.roleQuery,
        j.matchedKeywords.join("; "),
        j.jobUrl,
        j.companyLinkedInUrl,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function targetsCsv(
  targets: ReturnType<typeof loadTargets>,
): string {
  const headers = [
    "targetId",
    "personName",
    "personTitle",
    "kind",
    "companyName",
    "jobTitle",
    "geo",
    "personLinkedInUrl",
    "jobUrl",
    "connectNote",
    "referralMessage",
  ];
  const lines = [headers.join(",")];
  for (const t of targets) {
    lines.push(
      [
        t.id,
        t.personName,
        t.personTitle,
        t.kind,
        t.companyName,
        t.jobTitle,
        t.geo,
        t.personLinkedInUrl,
        t.jobUrl,
        t.connectNote,
        t.referralMessage,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isReferralDryRun();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("referral-export");
  const writer = createJsonlLogger(logPath);

  const jobs = loadJobs(runDir);
  const targets = loadTargets(runDir);

  const outDir = resolveOutputDir(runId);
  const exportDir = path.join(runDir, ARTIFACTS.exportDir);
  fs.mkdirSync(exportDir, { recursive: true });

  const jobsJson = path.join(outDir, "jobs.json");
  const jobsCsvPath = path.join(outDir, "jobs.csv");
  const targetsJson = path.join(outDir, "targets.json");
  const targetsCsvPath = path.join(outDir, "targets.csv");

  writeJson(jobsJson, jobs);
  fs.writeFileSync(jobsCsvPath, jobsCsv(jobs), "utf8");
  writeJson(targetsJson, targets);
  fs.writeFileSync(targetsCsvPath, targetsCsv(targets), "utf8");

  writeJson(path.join(exportDir, "jobs.json"), jobs);
  fs.writeFileSync(path.join(exportDir, "jobs.csv"), jobsCsv(jobs), "utf8");
  writeJson(path.join(exportDir, "targets.json"), targets);
  fs.writeFileSync(
    path.join(exportDir, "targets.csv"),
    targetsCsv(targets),
    "utf8",
  );

  ensureRunMeta(runDir, runId, config, "referral-export");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    dryRun,
    jobs: jobs.length,
    targets: targets.length,
  });

  console.log(
    `Exported ${jobs.length} jobs + ${targets.length} targets (dryRun=${dryRun})`,
  );
  console.log(`  → ${path.relative(process.cwd(), outDir)}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (jobs.length === 0 && targets.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: "Export wrote 0 rows.",
    };
  }

  return {
    exitCode: 0,
    message: `Exported ${jobs.length} jobs, ${targets.length} targets`,
  };
}
