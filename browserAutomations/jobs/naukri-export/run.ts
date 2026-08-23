import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  isNaukriDryRun,
  snapshotConfigFromEnv,
} from "../../lib/naukri/env.js";
import {
  ensureRunMeta,
  loadJobs,
  resolveOutputDir,
  resolveRunDir,
  writeJson,
} from "../../lib/naukri/io.js";
import { ARTIFACTS } from "../../lib/naukri/types.js";

function csvEscape(value: string | number | undefined | null): string {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isNaukriDryRun();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("naukri-export");
  const writer = createJsonlLogger(logPath);

  const jobs = loadJobs(runDir);
  const outDir = resolveOutputDir(runId);
  const exportDir = path.join(runDir, ARTIFACTS.exportDir);
  fs.mkdirSync(exportDir, { recursive: true });

  const headers = [
    "jobId",
    "title",
    "companyName",
    "location",
    "experience",
    "salary",
    "geo",
    "roleQuery",
    "keywordsMatched",
    "jobUrl",
    "postedAgo",
  ];
  const lines = [headers.join(",")];
  for (const j of jobs) {
    lines.push(
      [
        j.id,
        j.title,
        j.companyName,
        j.location,
        j.experience,
        j.salary,
        j.geo,
        j.roleQuery,
        j.keywordsMatched.join("; "),
        j.jobUrl,
        j.postedAgo,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const csv = lines.join("\n") + "\n";

  const jsonPath = path.join(outDir, "jobs.json");
  const csvPath = path.join(outDir, "jobs.csv");
  writeJson(jsonPath, jobs);
  fs.writeFileSync(csvPath, csv, "utf8");
  writeJson(path.join(exportDir, "jobs.json"), jobs);
  fs.writeFileSync(path.join(exportDir, "jobs.csv"), csv, "utf8");

  ensureRunMeta(runDir, runId, config, "naukri-export");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    dryRun,
    count: jobs.length,
  });

  console.log(`Exported ${jobs.length} Naukri jobs (dryRun=${dryRun})`);
  console.log(`  → ${path.relative(process.cwd(), outDir)}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (jobs.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: "Export wrote 0 jobs.",
    };
  }
  return { exitCode: 0, message: `Exported ${jobs.length} jobs` };
}
