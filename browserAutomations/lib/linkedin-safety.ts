/**
 * Shared LinkedIn risk-reduction helpers (rate caps, delays, profile lock).
 * These lower risk — they do **not** guarantee accounts will never be restricted.
 *
 * Tuned for established accounts (low-risk patterns):
 * - One concurrent session (profile lock)
 * - Random think times (≈3–15s between actions; 20–60s on profiles)
 * - Burst breaks 5–20 min after every 15–25 recorded actions
 * - Daily budgets favor views/searches over connects/messages
 */

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./paths.js";

export type SafetyAction =
  | "page_view"
  | "search"
  | "profile_view"
  | "invite"
  | "connect"
  | "message"
  | "reaction";

/**
 * Operation-specific human pause kinds (typical means tuned for LinkedIn / web browsing).
 * Legacy aliases: `short`→idle_micro, `read`→read_card, `type`→type_burst.
 */
export type HumanDelayOp =
  | "click"
  | "type_char"
  | "type_burst"
  | "read_card"
  | "read_profile"
  | "read_website"
  | "search"
  | "nav"
  | "invite_think"
  | "between_companies"
  | "idle_micro"
  | "between_actions"
  /** @deprecated use idle_micro */
  | "short"
  /** @deprecated use read_card / read_profile */
  | "read"
  /** @deprecated use type_burst */
  | "type";

/** @deprecated Prefer HumanDelayOp */
export type DelayKind = HumanDelayOp;

const USAGE_DIR = path.join(PROJECT_ROOT, "data", "linkedin-safety");
const USAGE_PATH = path.join(USAGE_DIR, "usage.json");
const LOCK_PATH = path.join(USAGE_DIR, "job.lock");

/**
 * Daily budgets (mid of “reasonable established account” ranges).
 * Connects/messages stay much lower than profile views / searches.
 */
const DEFAULT_CAPS: Record<SafetyAction, number> = {
  search: 70,
  profile_view: 180,
  page_view: 250,
  connect: 20,
  message: 20,
  invite: 20,
  reaction: 40,
};

/**
 * Triangular params [low, mode, high] in ms — mode ≈ typical human mean.
 * Sampling prefers triangular around the mode (not flat uniform).
 *
 * Baseline between-action think time ≈ 3–15s (between_actions / invite_think / nav).
 * Profile dwell ≈ 20–60s. Avoid constant ~1s intervals.
 */
type DelaySpec = { lo: number; mode: number; hi: number; note: string };

const DELAY_SPECS: Record<
  Exclude<HumanDelayOp, "short" | "read" | "type">,
  DelaySpec
> = {
  click: { lo: 900, mode: 1800, hi: 4000, note: "after deciding to click" },
  type_char: { lo: 90, mode: 150, hi: 260, note: "per character" },
  type_burst: {
    lo: 600,
    mode: 1400,
    hi: 2800,
    note: "burst fill + pause",
  },
  read_card: {
    lo: 3000,
    mode: 6000,
    hi: 12000,
    note: "scan search result card",
  },
  read_profile: {
    lo: 20_000,
    mode: 35_000,
    hi: 60_000,
    note: "dwell on person/company profile",
  },
  read_website: {
    lo: 12_000,
    mode: 20_000,
    hi: 35_000,
    note: "scan homepage",
  },
  search: {
    lo: 4000,
    mode: 7000,
    hi: 14_000,
    note: "after submit, before interact",
  },
  nav: { lo: 3000, mode: 5500, hi: 12_000, note: "after navigation settle" },
  invite_think: {
    lo: 4000,
    mode: 8000,
    hi: 15_000,
    note: "before next invitee/connect",
  },
  between_companies: {
    lo: 6000,
    mode: 12_000,
    hi: 20_000,
    note: "switching targets",
  },
  between_actions: {
    lo: 3000,
    mode: 7000,
    hi: 15_000,
    note: "generic think time between LI actions",
  },
  idle_micro: { lo: 800, mode: 1600, hi: 3200, note: "small pause / scroll gap" },
};

const LEGACY_DELAY_MAP: Record<"short" | "read" | "type", HumanDelayOp> = {
  short: "idle_micro",
  read: "read_card",
  type: "type_burst",
};

/** Chance of a longer “distraction” pause for realism. */
const DISTRACTION_CHANCE = 0.08;
const DISTRACTION_MULT_LO = 1.5;
const DISTRACTION_MULT_HI = 2.8;

type DayBucket = Partial<Record<SafetyAction, number>>;

type UsageFile = {
  /** YYYY-MM-DD (local calendar date) */
  date: string;
  counts: DayBucket;
  /** ISO timestamp when current job started (runtime guard) */
  jobStartedAt?: string;
  jobId?: string;
  /** Actions since last burst break (across jobs same day). */
  sessionActionsSinceBreak?: number;
  /** Next break after this many actions (rolled 15–25). */
  burstThreshold?: number;
  /** ms paused for burst breaks in the current job (excluded from runtime). */
  pausedMsForJob?: number;
};

export class SafetyLimitError extends Error {
  readonly soft = true as const;
  readonly code = "SAFETY_LIMIT" as const;
  readonly action: SafetyAction | "job_runtime";
  readonly used: number;
  readonly cap: number;

  constructor(
    action: SafetyAction | "job_runtime",
    used: number,
    cap: number,
    detail?: string,
  ) {
    const base =
      action === "job_runtime"
        ? `LinkedIn safety: job runtime exceeded ${cap} min (ran ~${used} min active). Stop and continue later.`
        : `LinkedIn safety: daily ${action} cap reached (${used}/${cap}). Stop for today and continue tomorrow.`;
    super(detail ? `${base} ${detail}` : base);
    this.name = "SafetyLimitError";
    this.action = action;
    this.used = used;
    this.cap = cap;
  }
}

export class LinkedInRestrictionError extends Error {
  readonly code = "LINKEDIN_RESTRICTION" as const;
  readonly url: string;

  constructor(url: string, detail?: string) {
    super(
      detail ||
        `LinkedIn restriction/checkpoint detected (url=${url}). ` +
          "Stop automation, cool down for 24–48h, and only continue after you can browse normally in a headed browser. " +
          "Do not re-run aggressively.",
    );
    this.name = "LinkedInRestrictionError";
    this.url = url;
  }
}

export class ProfileBusyError extends Error {
  readonly code = "PROFILE_BUSY" as const;
  readonly holderJobId?: string;
  readonly holderPid?: number;

  constructor(holder: string, meta?: { jobId?: string; pid?: number }) {
    super(
      `LinkedIn lock busy: another job is already running (${holder}). ` +
        "Only one LinkedIn job can run at a time — wait for it to finish, then retry.",
    );
    this.name = "ProfileBusyError";
    this.holderJobId = meta?.jobId;
    this.holderPid = meta?.pid;
  }
}

/**
 * Parse a non-negative int env var. Unset / blank / whitespace → default.
 * (Number("") is 0 in JS — never treat empty as a real value.)
 */
function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

function envFloat(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** Local calendar date key YYYY-MM-DD (aligned with invite pacing timezone). */
export function localDateKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getActionCap(action: SafetyAction): number {
  const envMap: Record<SafetyAction, string> = {
    invite: "LI_SAFE_MAX_INVITES_PER_DAY",
    connect: "LI_SAFE_MAX_CONNECTS_PER_DAY",
    search: "LI_SAFE_MAX_SEARCHES_PER_DAY",
    profile_view: "LI_SAFE_MAX_PROFILE_VIEWS_PER_DAY",
    page_view: "LI_SAFE_MAX_PAGE_VIEWS_PER_DAY",
    message: "LI_SAFE_MAX_MESSAGES_PER_DAY",
    reaction: "LI_SAFE_MAX_REACTIONS_PER_DAY",
  };
  return envInt(envMap[action], DEFAULT_CAPS[action]);
}

export function getMaxJobRuntimeMin(): number {
  // Active browsing time (burst pauses are excluded). Default 60 min — stop and resume later.
  const raw = process.env.LI_SAFE_MAX_JOB_RUNTIME_MIN;
  if (raw === undefined || String(raw).trim() === "") return 60;
  const n = Number(raw);
  // 0 min is not a valid budget (would trip on first assert); fall back to default
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

export function getDelayMultiplier(): number {
  return envFloat("LI_SAFE_DELAY_MULT", 1);
}

/** Actions between long breaks (default 15–25, randomized per break). */
export function getBurstActionRange(): { lo: number; hi: number } {
  return {
    lo: envInt("LI_SAFE_BURST_ACTIONS_LO", 15),
    hi: envInt("LI_SAFE_BURST_ACTIONS_HI", 25),
  };
}

/** Burst pause length in minutes (default 5–20). */
export function getBurstPauseRangeMin(): { lo: number; hi: number } {
  return {
    lo: envFloat("LI_SAFE_BURST_PAUSE_MIN_LO", 5),
    hi: envFloat("LI_SAFE_BURST_PAUSE_MIN_HI", 20),
  };
}

function rollBurstThreshold(): number {
  const { lo, hi } = getBurstActionRange();
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return a + Math.floor(Math.random() * (b - a + 1));
}

function emptyUsage(date: string): UsageFile {
  return {
    date,
    counts: {},
    sessionActionsSinceBreak: 0,
    burstThreshold: rollBurstThreshold(),
    pausedMsForJob: 0,
  };
}

function readUsage(): UsageFile {
  try {
    if (!fs.existsSync(USAGE_PATH)) return emptyUsage(localDateKey());
    const raw = JSON.parse(fs.readFileSync(USAGE_PATH, "utf8")) as UsageFile;
    const today = localDateKey();
    if (!raw || raw.date !== today) {
      return emptyUsage(today);
    }
    return {
      date: today,
      counts: raw.counts ?? {},
      jobStartedAt: raw.jobStartedAt,
      jobId: raw.jobId,
      sessionActionsSinceBreak: raw.sessionActionsSinceBreak ?? 0,
      burstThreshold: raw.burstThreshold ?? rollBurstThreshold(),
      pausedMsForJob: raw.pausedMsForJob ?? 0,
    };
  } catch {
    return emptyUsage(localDateKey());
  }
}

function writeUsage(usage: UsageFile): void {
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  const tmp = `${USAGE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(usage, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, USAGE_PATH);
}

export function getUsageCount(action: SafetyAction): number {
  const usage = readUsage();
  return Math.max(0, usage.counts[action] ?? 0);
}

/** How many more of this action are allowed today (never negative). */
export function remainingCap(action: SafetyAction): number {
  return Math.max(0, getActionCap(action) - getUsageCount(action));
}

/**
 * Throw SafetyLimitError if adding `n` would exceed today's cap.
 * Soft limit — runner treats as clean exit, not a crash loop.
 */
export function assertWithinCap(action: SafetyAction, n = 1): void {
  const used = getUsageCount(action);
  const cap = getActionCap(action);
  const need = Math.max(0, Math.floor(n));
  if (used + need > cap) {
    throw new SafetyLimitError(
      action,
      used,
      cap,
      need > 1 ? `Need ${need} more.` : undefined,
    );
  }
}

/** Persist successful action counts (call after the LinkedIn action succeeded). */
export function recordAction(action: SafetyAction, n = 1): void {
  const add = Math.max(0, Math.floor(n));
  if (add === 0) return;
  const usage = readUsage();
  usage.counts[action] = (usage.counts[action] ?? 0) + add;
  usage.sessionActionsSinceBreak =
    (usage.sessionActionsSinceBreak ?? 0) + add;
  if (!usage.burstThreshold) {
    usage.burstThreshold = rollBurstThreshold();
  }
  writeUsage(usage);
}

/**
 * After enough recorded actions, pause 5–20 minutes (burst break).
 * Call after batches of LinkedIn work (also invoked from `humanDelay`).
 * Pause time is excluded from job runtime.
 */
export async function maybeBurstPause(opts?: {
  /** Force a break regardless of counter (tests / manual cool-down). */
  force?: boolean;
}): Promise<number> {
  if (process.env.LI_SAFE_BURST_PAUSE === "false") return 0;

  const usage = readUsage();
  const since = usage.sessionActionsSinceBreak ?? 0;
  const threshold = usage.burstThreshold ?? rollBurstThreshold();
  if (!opts?.force && since < threshold) return 0;

  const { lo, hi } = getBurstPauseRangeMin();
  const pauseMin = sampleTriangular(lo, (lo + hi) / 2, hi);
  const pauseMs = Math.round(pauseMin * 60_000);

  console.log(
    `\n[linkedin-safety] Burst break after ${since} actions ` +
      `(threshold ${threshold}) — pausing ~${pauseMin.toFixed(1)} min ` +
      `(${Math.round(pauseMs / 1000)}s). Activity should spread over the day.\n`,
  );

  usage.sessionActionsSinceBreak = 0;
  usage.burstThreshold = rollBurstThreshold();
  usage.pausedMsForJob = (usage.pausedMsForJob ?? 0) + pauseMs;
  writeUsage(usage);

  await new Promise((r) => setTimeout(r, pauseMs));
  return pauseMs;
}

/** recordAction + maybeBurstPause (preferred after LinkedIn mutations). */
export async function recordActionPaced(
  action: SafetyAction,
  n = 1,
): Promise<void> {
  recordAction(action, n);
  await maybeBurstPause();
}

function remainingAfter(used: number, cap: number): number {
  return Math.max(0, Math.floor(cap) - Math.max(0, Math.floor(used)));
}

/** Pure clamp used by invite/lead batch sizing (also unit-tested). */
export function clampDesiredToCap(
  desired: number,
  used: number,
  cap: number,
): number {
  return Math.min(Math.max(0, Math.floor(desired)), remainingAfter(used, cap));
}

/**
 * Cap an intended batch against remaining daily invite allowance.
 * Returns min(desired, remainingCap(action)).
 */
export function clampToRemainingCap(
  action: SafetyAction,
  desired: number,
): number {
  return clampDesiredToCap(desired, getUsageCount(action), getActionCap(action));
}

/** Start (or refresh) per-job runtime clock stored in usage.json. */
export function beginJobRuntime(jobId?: string): void {
  const usage = readUsage();
  usage.jobStartedAt = new Date().toISOString();
  usage.jobId = jobId;
  usage.pausedMsForJob = 0;
  if (!usage.burstThreshold) {
    usage.burstThreshold = rollBurstThreshold();
  }
  writeUsage(usage);
}

export function clearJobRuntime(): void {
  const usage = readUsage();
  delete usage.jobStartedAt;
  delete usage.jobId;
  usage.pausedMsForJob = 0;
  writeUsage(usage);
}

export function assertJobRuntime(): void {
  const usage = readUsage();
  if (!usage.jobStartedAt) return;
  const started = Date.parse(usage.jobStartedAt);
  if (!Number.isFinite(started)) return;
  const pausedMs = usage.pausedMsForJob ?? 0;
  const elapsedMin = (Date.now() - started - pausedMs) / 60_000;
  const cap = getMaxJobRuntimeMin();
  if (elapsedMin > cap) {
    throw new SafetyLimitError("job_runtime", Math.ceil(elapsedMin), cap);
  }
}

function randFloat(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

/** Triangular distribution on [lo, hi] with mode (peak density at typical human mean). */
export function sampleTriangular(lo: number, mode: number, hi: number): number {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const c = Math.min(b, Math.max(a, mode));
  if (b <= a) return a;
  const u = Math.random();
  const fc = (c - a) / (b - a);
  if (u < fc) {
    return a + Math.sqrt(u * (b - a) * (c - a));
  }
  return b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

/**
 * Log-normal sample centered near `mode`, clipped to [lo, hi].
 * Uses σ≈0.35 so most mass sits near the typical human mean with a longer right tail.
 */
export function sampleLogNormalClipped(
  lo: number,
  mode: number,
  hi: number,
  sigma = 0.35,
): number {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const m = Math.min(b, Math.max(a, mode));
  // Box–Muller → N(0,1)
  const u1 = Math.max(1e-12, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = m * Math.exp(sigma * z);
  return Math.min(b, Math.max(a, raw));
}

export function resolveDelayOp(op: HumanDelayOp): Exclude<
  HumanDelayOp,
  "short" | "read" | "type"
> {
  if (op === "short" || op === "read" || op === "type") {
    return LEGACY_DELAY_MAP[op] as Exclude<
      HumanDelayOp,
      "short" | "read" | "type"
    >;
  }
  return op;
}

export function getDelaySpec(op: HumanDelayOp): DelaySpec {
  return DELAY_SPECS[resolveDelayOp(op)];
}

export type SampleDelayOpts = {
  minMs?: number;
  maxMs?: number;
  /** Prefer triangular (default) or log-normal around the mode. */
  distribution?: "triangular" | "lognormal";
  /** Force/skip distraction multiplier (default: 5% chance). */
  distraction?: boolean;
};

/**
 * Sample a delay in ms without sleeping (for tests / range printing).
 * Applies LI_SAFE_DELAY_MULT and optional min/max clamps.
 */
export function sampleHumanDelayMs(
  op: HumanDelayOp = "idle_micro",
  opts?: SampleDelayOpts,
): number {
  const spec = getDelaySpec(op);
  const dist = opts?.distribution ?? "triangular";
  let ms =
    dist === "lognormal"
      ? sampleLogNormalClipped(spec.lo, spec.mode, spec.hi)
      : sampleTriangular(spec.lo, spec.mode, spec.hi);

  const distract =
    opts?.distraction === true
      ? true
      : opts?.distraction === false
        ? false
        : Math.random() < DISTRACTION_CHANCE;
  if (distract) {
    ms *= randFloat(DISTRACTION_MULT_LO, DISTRACTION_MULT_HI);
  }

  ms = Math.round(ms * getDelayMultiplier());

  if (opts?.minMs !== undefined && Number.isFinite(opts.minMs)) {
    ms = Math.max(ms, Math.floor(opts.minMs));
  }
  if (opts?.maxMs !== undefined && Number.isFinite(opts.maxMs) && opts.maxMs > 0) {
    ms = Math.min(ms, Math.floor(opts.maxMs));
  }
  return Math.max(0, ms);
}

/**
 * Randomized human-like pause for an operation.
 * Multiply with LI_SAFE_DELAY_MULT (default 1). Occasional distraction (~8%).
 * Optional `minMs` enforces a floor (e.g. INVITE_DELAY_MS / LEAD_DELAY_MS).
 * May also take a burst break if enough LinkedIn actions accumulated.
 */
export async function humanDelay(
  op: HumanDelayOp = "idle_micro",
  opts?: SampleDelayOpts & { skipBurstCheck?: boolean },
): Promise<number> {
  const ms = sampleHumanDelayMs(op, opts);
  if (ms > 0) {
    await new Promise((r) => setTimeout(r, ms));
  }
  if (!opts?.skipBurstCheck) {
    await maybeBurstPause();
  }
  return ms;
}

/** Specs + notes for docs / verify script (resolved ops only). */
export function listDelayOps(): Array<{
  op: Exclude<HumanDelayOp, "short" | "read" | "type">;
  lo: number;
  mode: number;
  hi: number;
  note: string;
}> {
  return (
    Object.entries(DELAY_SPECS) as Array<
      [Exclude<HumanDelayOp, "short" | "read" | "type">, DelaySpec]
    >
  ).map(([op, s]) => ({
    op,
    lo: s.lo,
    mode: s.mode,
    hi: s.hi,
    note: s.note,
  }));
}

/**
 * Restriction / unusual-activity style pages (distinct from plain /login).
 * Heal must not auto-retry these aggressively.
 */
export function looksLikeRestrictionOrChallenge(url: string): boolean {
  try {
    const lower = url.toLowerCase();
    const { pathname } = new URL(url);
    return (
      pathname.includes("/checkpoint") ||
      lower.includes("/challenge") ||
      lower.includes("captcha") ||
      lower.includes("security-verification") ||
      lower.includes("/check/add-phone") ||
      lower.includes("unusual") ||
      lower.includes("restricted") ||
      lower.includes("account-restricted") ||
      lower.includes("challengeident") ||
      lower.includes("/authwall")
    );
  } catch {
    return false;
  }
}

/**
 * Throw LinkedInRestrictionError when URL looks like a hard challenge/restriction.
 * Plain /login without checkpoint signals is left to callers (missing session).
 */
export function assertNoRestriction(pageUrl: string, contextLabel?: string): void {
  if (!looksLikeRestrictionOrChallenge(pageUrl)) return;
  const label = contextLabel ? ` during ${contextLabel}` : "";
  throw new LinkedInRestrictionError(
    pageUrl,
    `LinkedIn restriction/checkpoint detected${label} (url=${pageUrl}). ` +
      "Stop automation and cool down 24–48h. Do not retry in a loop.",
  );
}

type LockPayload = {
  pid: number;
  jobId: string;
  startedAt: string;
};

/** Nest depth for same-process re-entrant acquires (runner + withLinkedInJobGuard). */
let lockDepth = 0;

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(): LockPayload | null {
  try {
    if (!fs.existsSync(LOCK_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as LockPayload;
    if (!raw?.pid) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeLockExclusive(payload: LockPayload): boolean {
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify(payload, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
    if (code === "EEXIST") return false;
    throw err;
  }
}

function clearStaleLockFile(): void {
  const existing = readLock();
  if (!existing) {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      /* ignore */
    }
    return;
  }
  if (existing.pid === process.pid) return;
  if (isPidAlive(existing.pid)) return;
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* race */
  }
}

/**
 * Acquire exclusive LinkedIn job lock (one concurrent LinkedIn-touching process).
 * Re-entrant in the same process (nest depth). Stale locks from dead PIDs are cleared.
 * Throws ProfileBusyError if another live process holds the lock — caller should exit.
 */
export function acquireLinkedInJobLock(jobId: string): void {
  fs.mkdirSync(USAGE_DIR, { recursive: true });

  if (lockDepth > 0) {
    lockDepth += 1;
    return;
  }

  const payload: LockPayload = {
    pid: process.pid,
    jobId,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    clearStaleLockFile();
    if (writeLockExclusive(payload)) {
      lockDepth = 1;
      return;
    }

    const existing = readLock();
    if (!existing) {
      // Lost race with create/delete — retry
      continue;
    }
    if (existing.pid === process.pid) {
      lockDepth = 1;
      return;
    }
    if (isPidAlive(existing.pid)) {
      throw new ProfileBusyError(
        `${existing.jobId} pid=${existing.pid} since ${existing.startedAt}`,
        { jobId: existing.jobId, pid: existing.pid },
      );
    }
    // Dead pid — clear and retry
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      /* retry */
    }
  }

  throw new ProfileBusyError("could not acquire lock after retries");
}

/**
 * Release one nest level of the LinkedIn job lock.
 * @returns true when the lock file was removed (outermost release).
 */
export function releaseLinkedInJobLock(): boolean {
  if (lockDepth <= 0) {
    // Best-effort: if we own the file, remove it
    const existing = readLock();
    if (existing?.pid === process.pid) {
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        /* ignore */
      }
      return true;
    }
    return false;
  }

  lockDepth -= 1;
  if (lockDepth > 0) return false;

  const existing = readLock();
  if (!existing || existing.pid !== process.pid) return false;
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
  return true;
}

/** True when this process currently holds the LinkedIn job lock. */
export function holdsLinkedInJobLock(): boolean {
  return lockDepth > 0;
}

/** Peek at the lock file (for CLI / status). */
export function peekLinkedInJobLock(): LockPayload | null {
  const existing = readLock();
  if (!existing) return null;
  if (!isPidAlive(existing.pid) && existing.pid !== process.pid) {
    return null;
  }
  return existing;
}

/**
 * Hold the LinkedIn job lock for the duration of `fn`.
 * Nested calls in the same process share the lock (nest depth).
 * Clears job runtime only when the outermost guard exits.
 */
export async function withLinkedInJobGuard<T>(
  jobId: string,
  fn: () => Promise<T>,
): Promise<T> {
  acquireLinkedInJobLock(jobId);
  try {
    return await fn();
  } finally {
    const fullyReleased = releaseLinkedInJobLock();
    if (fullyReleased) {
      clearJobRuntime();
    }
  }
}

/**
 * Whether a job should take the exclusive LinkedIn lock for its whole run.
 * - `linkedinLock: true|false` overrides
 * - else: requiresAuth or tags include "linkedin"
 */
export function jobNeedsLinkedInLock(job: {
  requiresAuth: boolean;
  tags: string[];
  linkedinLock?: boolean;
}): boolean {
  if (job.linkedinLock === false) return false;
  if (job.linkedinLock === true) return true;
  if (job.requiresAuth) return true;
  return job.tags.some((t) => t.toLowerCase() === "linkedin");
}

/** Snapshot for logging / debugging. */
export function safetyStatus(): {
  date: string;
  counts: DayBucket;
  caps: Record<SafetyAction, number>;
  remaining: Record<SafetyAction, number>;
  maxJobRuntimeMin: number;
  delayMult: number;
  sessionActionsSinceBreak: number;
  burstThreshold: number;
} {
  const actions: SafetyAction[] = [
    "page_view",
    "search",
    "profile_view",
    "invite",
    "connect",
    "message",
    "reaction",
  ];
  const usage = readUsage();
  const counts: DayBucket = {};
  const caps = {} as Record<SafetyAction, number>;
  const remaining = {} as Record<SafetyAction, number>;
  for (const a of actions) {
    counts[a] = getUsageCount(a);
    caps[a] = getActionCap(a);
    remaining[a] = remainingCap(a);
  }
  return {
    date: localDateKey(),
    counts,
    caps,
    remaining,
    maxJobRuntimeMin: getMaxJobRuntimeMin(),
    delayMult: getDelayMultiplier(),
    sessionActionsSinceBreak: usage.sessionActionsSinceBreak ?? 0,
    burstThreshold: usage.burstThreshold ?? rollBurstThreshold(),
  };
}

export const LINKEDIN_SAFETY_PATHS = {
  usageDir: USAGE_DIR,
  usageFile: USAGE_PATH,
  lockFile: LOCK_PATH,
} as const;
