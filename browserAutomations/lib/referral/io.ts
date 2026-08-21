import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import {
  ARTIFACTS,
  type JobPosting,
  type ReferralPerson,
  type ReferralRunConfigSnapshot,
  type ReferralRunMeta,
  type ReferralTarget,
} from "./types.js";

export const REFERRAL_DATA_DIR = path.join(PROJECT_ROOT, "data", "referral");
export const REFERRAL_OUTPUT_DIR = path.join(PROJECT_ROOT, "output", "referral");

export function createRunId(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function getLatestRunId(): string | undefined {
  if (!fs.existsSync(REFERRAL_DATA_DIR)) return undefined;
  const dirs = fs
    .readdirSync(REFERRAL_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : undefined;
}

/**
 * Resolve `data/referral/<runId>/`.
 * - If REFERRAL_RUN_ID is set, use it.
 * - Else if createIfMissing, mint a new timestamp id (search).
 * - Else use latest existing run.
 */
export function resolveRunDir(options?: {
  createIfMissing?: boolean;
}): { runId: string; runDir: string } {
  const explicit = process.env.REFERRAL_RUN_ID?.trim();
  if (explicit) {
    const runDir = path.join(REFERRAL_DATA_DIR, explicit);
    fs.mkdirSync(runDir, { recursive: true });
    return { runId: explicit, runDir };
  }

  if (options?.createIfMissing) {
    const runId = createRunId();
    const runDir = path.join(REFERRAL_DATA_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    process.env.REFERRAL_RUN_ID = runId;
    return { runId, runDir };
  }

  const latest = getLatestRunId();
  if (!latest) {
    throw new Error(
      "No referral run found. Set REFERRAL_RUN_ID or run referral-search-jobs first.",
    );
  }
  const runDir = path.join(REFERRAL_DATA_DIR, latest);
  process.env.REFERRAL_RUN_ID = latest;
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
  config: ReferralRunConfigSnapshot,
  step?: string,
): ReferralRunMeta {
  const metaPath = artifactPath(runDir, ARTIFACTS.meta);
  const existing = readJson<ReferralRunMeta>(metaPath);
  const now = new Date().toISOString();
  const meta: ReferralRunMeta = existing
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

export function loadJobs(runDir: string): JobPosting[] {
  return readJson<JobPosting[]>(artifactPath(runDir, ARTIFACTS.jobs)) ?? [];
}

export function loadPeople(runDir: string): ReferralPerson[] {
  return readJson<ReferralPerson[]>(artifactPath(runDir, ARTIFACTS.people)) ?? [];
}

export function loadTargets(runDir: string): ReferralTarget[] {
  return (
    readJson<ReferralTarget[]>(artifactPath(runDir, ARTIFACTS.targets)) ?? []
  );
}

export function resolveOutputDir(runId: string): string {
  const out = path.join(REFERRAL_OUTPUT_DIR, runId);
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

export function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|pvt|private|limited)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLinkedInUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.trim());
    u.hash = "";
    u.search = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/+$/, "") || "";
    return `${u.protocol}//${host}${pathname}/`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "") + "/";
  }
}
