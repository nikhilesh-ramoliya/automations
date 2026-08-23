/**
 * Naukri daily caps + human-like delays (mirrors linkedin-safety, separate counters).
 */

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export type NaukriSafetyAction = "search" | "page_view" | "apply";

const USAGE_DIR = path.join(PROJECT_ROOT, "data", "naukri-safety");
const USAGE_PATH = path.join(USAGE_DIR, "usage.json");
const LOCK_PATH = path.join(USAGE_DIR, "job.lock");

const DEFAULT_CAPS: Record<NaukriSafetyAction, number> = {
  search: 40,
  page_view: 120,
  apply: 25,
};

type DayBucket = Partial<Record<NaukriSafetyAction, number>>;

type UsageFile = {
  date: string;
  counts: DayBucket;
  jobStartedAt?: string;
  jobId?: string;
  sessionActionsSinceBreak?: number;
  burstThreshold?: number;
  pausedMsForJob?: number;
};

export class NaukriSafetyLimitError extends Error {
  readonly soft = true as const;
  readonly code = "NAUKRI_SAFETY_LIMIT" as const;
  readonly action: NaukriSafetyAction | "job_runtime";
  readonly used: number;
  readonly cap: number;

  constructor(
    action: NaukriSafetyAction | "job_runtime",
    used: number,
    cap: number,
    detail?: string,
  ) {
    super(
      detail ??
        `Naukri safety: daily ${action} cap reached (${used}/${cap}). Stop and continue tomorrow.`,
    );
    this.name = "NaukriSafetyLimitError";
    this.action = action;
    this.used = used;
    this.cap = cap;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function localDateKey(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function getActionCap(action: NaukriSafetyAction): number {
  const map: Record<NaukriSafetyAction, string> = {
    search: "NAUKRI_SAFE_MAX_SEARCHES_PER_DAY",
    page_view: "NAUKRI_SAFE_MAX_PAGE_VIEWS_PER_DAY",
    apply: "NAUKRI_SAFE_MAX_APPLIES_PER_DAY",
  };
  return envInt(map[action], DEFAULT_CAPS[action]);
}

export function getMaxJobRuntimeMin(): number {
  const raw = process.env.NAUKRI_SAFE_MAX_JOB_RUNTIME_MIN;
  if (raw === undefined || String(raw).trim() === "") return 45;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 45;
}

export function getDelayMultiplier(): number {
  return envFloat("NAUKRI_SAFE_DELAY_MULT", 1);
}

function loadUsage(): UsageFile {
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  const today = localDateKey();
  if (!fs.existsSync(USAGE_PATH)) {
    return { date: today, counts: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_PATH, "utf8")) as UsageFile;
    if (raw.date !== today) {
      return { date: today, counts: {} };
    }
    return raw;
  } catch {
    return { date: today, counts: {} };
  }
}

function saveUsage(u: UsageFile): void {
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  fs.writeFileSync(USAGE_PATH, JSON.stringify(u, null, 2) + "\n", "utf8");
}

export function remainingCap(action: NaukriSafetyAction): number {
  const u = loadUsage();
  const used = u.counts[action] ?? 0;
  return Math.max(0, getActionCap(action) - used);
}

export function assertWithinCap(action: NaukriSafetyAction, n = 1): void {
  const u = loadUsage();
  const used = u.counts[action] ?? 0;
  const cap = getActionCap(action);
  if (used + n > cap) {
    throw new NaukriSafetyLimitError(action, used, cap);
  }
}

export function recordAction(action: NaukriSafetyAction, n = 1): void {
  const u = loadUsage();
  u.counts[action] = (u.counts[action] ?? 0) + n;
  u.sessionActionsSinceBreak = (u.sessionActionsSinceBreak ?? 0) + n;
  const threshold = u.burstThreshold ?? 15 + Math.floor(Math.random() * 11);
  u.burstThreshold = threshold;
  saveUsage(u);
}

let jobStartedAtMs: number | undefined;
let pausedMs = 0;

export function beginJobRuntime(jobId?: string): void {
  const u = loadUsage();
  jobStartedAtMs = Date.now();
  pausedMs = 0;
  u.jobStartedAt = new Date().toISOString();
  u.jobId = jobId;
  u.pausedMsForJob = 0;
  saveUsage(u);
}

export function clearJobRuntime(): void {
  jobStartedAtMs = undefined;
  pausedMs = 0;
  const u = loadUsage();
  delete u.jobStartedAt;
  delete u.jobId;
  delete u.pausedMsForJob;
  saveUsage(u);
}

export function assertJobRuntime(): void {
  if (jobStartedAtMs == null) return;
  const elapsed = Date.now() - jobStartedAtMs - pausedMs;
  const maxMs = getMaxJobRuntimeMin() * 60_000;
  if (elapsed > maxMs) {
    throw new NaukriSafetyLimitError(
      "job_runtime",
      Math.round(elapsed / 60_000),
      getMaxJobRuntimeMin(),
      `Naukri job runtime exceeded (~${getMaxJobRuntimeMin()} min). Resume later.`,
    );
  }
}

/** Triangular-ish think times (ms). */
export async function naukriDelay(
  kind:
    | "click"
    | "nav"
    | "search"
    | "read_card"
    | "between"
    | "apply_think" = "between",
  opts?: { minMs?: number },
): Promise<void> {
  const specs: Record<string, { lo: number; mode: number; hi: number }> = {
    click: { lo: 800, mode: 1600, hi: 3500 },
    nav: { lo: 2500, mode: 4500, hi: 9000 },
    search: { lo: 3500, mode: 6000, hi: 12_000 },
    read_card: { lo: 2500, mode: 5000, hi: 10_000 },
    between: { lo: 3000, mode: 6500, hi: 14_000 },
    apply_think: { lo: 4000, mode: 8000, hi: 16_000 },
  };
  const s = specs[kind] ?? specs.between!;
  const u = Math.random();
  const mid = (s.mode - s.lo) / (s.hi - s.lo || 1);
  let ms =
    u < mid
      ? s.lo + Math.sqrt(u * (s.hi - s.lo) * (s.mode - s.lo))
      : s.hi - Math.sqrt((1 - u) * (s.hi - s.lo) * (s.hi - s.mode));
  ms *= getDelayMultiplier();
  if (opts?.minMs != null) ms = Math.max(ms, opts.minMs);
  // Occasional distraction
  if (Math.random() < 0.08) ms *= 1.5 + Math.random() * 1.2;

  // Burst breaks are OFF by default (too slow for apply batches).
  // Opt in with NAUKRI_SAFE_BURST_PAUSE=true — then pauses ~30–90s every ~20 actions.
  const usage = loadUsage();
  const since = usage.sessionActionsSinceBreak ?? 0;
  const thresh = usage.burstThreshold ?? 20;
  if (
    process.env.NAUKRI_SAFE_BURST_PAUSE === "true" &&
    since >= thresh
  ) {
    const pauseSec = 30 + Math.random() * 60; /* 30–90s, not minutes */
    const pauseMs = Math.round(pauseSec * 1000);
    console.log(
      `[naukri-safety] Short burst pause ~${pauseSec.toFixed(0)}s after ${since} actions…`,
    );
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, pauseMs));
    pausedMs += Date.now() - t0;
    usage.sessionActionsSinceBreak = 0;
    usage.burstThreshold = 15 + Math.floor(Math.random() * 11);
    usage.pausedMsForJob = (usage.pausedMsForJob ?? 0) + (Date.now() - t0);
    saveUsage(usage);
  }

  await new Promise((r) => setTimeout(r, Math.round(ms)));
}

export function acquireNaukriJobLock(jobId: string): void {
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as {
        pid?: number;
        jobId?: string;
      };
      if (raw.pid && raw.pid !== process.pid) {
        try {
          process.kill(raw.pid, 0);
          throw new Error(
            `[naukri-lock] Another Naukri job holds the lock (job=${raw.jobId}, pid=${raw.pid}). Wait for it to finish.`,
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
          // stale lock
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("[naukri-lock]")) {
        throw err;
      }
    }
  }
  fs.writeFileSync(
    LOCK_PATH,
    JSON.stringify(
      { pid: process.pid, jobId, at: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
}

export function releaseNaukriJobLock(): void {
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as {
      pid?: number;
    };
    if (raw.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

export async function withNaukriJobGuard<T>(
  jobId: string,
  fn: () => Promise<T>,
): Promise<T> {
  acquireNaukriJobLock(jobId);
  try {
    beginJobRuntime(jobId);
    return await fn();
  } finally {
    clearJobRuntime();
    releaseNaukriJobLock();
  }
}

export const NAUKRI_SAFETY_PATHS = {
  usage: USAGE_PATH,
  lock: LOCK_PATH,
  dir: USAGE_DIR,
};
