import fs from "node:fs";
import path from "node:path";
import type { JobDefinition } from "./job-types.js";
import { JOBS_DIR } from "./paths.js";

function isJobDefinition(raw: unknown): raw is JobDefinition {
  if (!raw || typeof raw !== "object") return false;
  const j = raw as Record<string, unknown>;
  return (
    typeof j.id === "string" &&
    typeof j.name === "string" &&
    typeof j.description === "string" &&
    typeof j.entry === "string" &&
    Array.isArray(j.tags) &&
    typeof j.requiresAuth === "boolean" &&
    Array.isArray(j.env)
  );
}

/** Absolute path to a job's folder. */
export function jobDir(jobId: string): string {
  return path.join(JOBS_DIR, jobId);
}

/** Absolute path to the job entry module. */
export function jobEntryPath(job: JobDefinition): string {
  return path.join(jobDir(job.id), job.entry);
}

/**
 * Auto-discover jobs from each jobs/<id>/job.json file.
 * Skips folders starting with _ (templates) and missing/invalid job.json.
 */
export function discoverJobs(): JobDefinition[] {
  if (!fs.existsSync(JOBS_DIR)) return [];

  const jobs: JobDefinition[] = [];
  for (const name of fs.readdirSync(JOBS_DIR)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const metaPath = path.join(JOBS_DIR, name, "job.json");
    if (!fs.existsSync(metaPath)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (err) {
      console.warn(
        "Skipping invalid job.json: " + metaPath + " (" + String(err) + ")",
      );
      continue;
    }

    if (!isJobDefinition(raw)) {
      console.warn("Skipping incomplete job.json: " + metaPath);
      continue;
    }

    if (raw.id !== name) {
      console.warn(
        'Job folder "' +
          name +
          '" id mismatch (job.json id="' +
          raw.id +
          '") - using folder name as id.',
      );
      raw = { ...raw, id: name };
    }

    jobs.push(raw as JobDefinition);
  }

  return jobs.sort((a, b) => a.id.localeCompare(b.id));
}

export function getJob(jobId: string): JobDefinition | undefined {
  return discoverJobs().find((j) => j.id === jobId);
}

export function requireJob(jobId: string): JobDefinition {
  const job = getJob(jobId);
  if (!job) {
    const available = discoverJobs()
      .map((j) => j.id)
      .join(", ");
    throw new Error(
      'Unknown job "' +
        jobId +
        '".' +
        (available ? " Available: " + available : " No jobs registered."),
    );
  }
  return job;
}

/** Write a machine-readable snapshot for agents/CI (optional). */
export function writeRegistrySnapshot(
  outPath = path.join(JOBS_DIR, "registry.json"),
): JobDefinition[] {
  const jobs = discoverJobs();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          description: j.description,
          tags: j.tags,
          requiresAuth: j.requiresAuth,
          entry: path.posix.join(j.id, j.entry.replace(/\\/g, "/")),
          npmScript: j.run?.npmScript,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  return jobs;
}
