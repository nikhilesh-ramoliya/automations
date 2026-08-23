import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import {
  ARTIFACTS,
  type NaukriJob,
  type NaukriRunConfigSnapshot,
  type NaukriRunMeta,
} from "./types.js";

export const NAUKRI_DATA_DIR = path.join(PROJECT_ROOT, "data", "naukri");
export const NAUKRI_OUTPUT_DIR = path.join(PROJECT_ROOT, "output", "naukri");

export function createRunId(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function getLatestRunId(): string | undefined {
  if (!fs.existsSync(NAUKRI_DATA_DIR)) return undefined;
  // Only real pipeline runs: YYYYMMDD-HHMMSS (ignore probe/debug folders)
  const runIdRe = /^\d{8}-\d{6}$/;
  const dirs = fs
    .readdirSync(NAUKRI_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && runIdRe.test(d.name))
    .map((d) => d.name)
    .filter((name) =>
      fs.existsSync(path.join(NAUKRI_DATA_DIR, name, ARTIFACTS.jobs)),
    )
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : undefined;
}

export function resolveRunDir(options?: {
  createIfMissing?: boolean;
}): { runId: string; runDir: string } {
  const explicit = process.env.NAUKRI_RUN_ID?.trim();
  if (explicit) {
    const runDir = path.join(NAUKRI_DATA_DIR, explicit);
    fs.mkdirSync(runDir, { recursive: true });
    return { runId: explicit, runDir };
  }

  if (options?.createIfMissing) {
    const runId = createRunId();
    const runDir = path.join(NAUKRI_DATA_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    process.env.NAUKRI_RUN_ID = runId;
    return { runId, runDir };
  }

  const latest = getLatestRunId();
  if (!latest) {
    throw new Error(
      "No Naukri run found. Set NAUKRI_RUN_ID or run naukri-search-jobs first.",
    );
  }
  const runDir = path.join(NAUKRI_DATA_DIR, latest);
  process.env.NAUKRI_RUN_ID = latest;
  return { runId: latest, runDir };
}

export function artifactPath(runDir: string, name: string): string {
  return path.join(runDir, name);
}

export function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function ensureRunMeta(
  runDir: string,
  runId: string,
  config: NaukriRunConfigSnapshot,
  step?: string,
): NaukriRunMeta {
  const metaPath = artifactPath(runDir, ARTIFACTS.meta);
  const existing = readJson<NaukriRunMeta>(metaPath);
  const now = new Date().toISOString();
  const meta: NaukriRunMeta = existing
    ? {
        ...existing,
        updatedAt: now,
        config: { ...existing.config, ...config },
        stepsCompleted: existing.stepsCompleted ?? [],
      }
    : {
        runId,
        createdAt: now,
        updatedAt: now,
        config,
        stepsCompleted: [],
      };

  if (step && !meta.stepsCompleted.includes(step)) {
    meta.stepsCompleted.push(step);
  }
  writeJson(metaPath, meta);
  return meta;
}

export function loadJobs(runDir: string): NaukriJob[] {
  return readJson<NaukriJob[]>(artifactPath(runDir, ARTIFACTS.jobs)) ?? [];
}

export function resolveOutputDir(runId: string): string {
  const out = path.join(NAUKRI_OUTPUT_DIR, runId);
  fs.mkdirSync(out, { recursive: true });
  return out;
}

export function slugId(prefix: string, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${prefix}-${slug || "x"}`;
}

export function slugifyQuery(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
