import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { JobDefinition, JobHealConfig } from "./job-types.js";
import {
  createJsonlLogger,
  healLogPath,
  type LogWriter,
} from "./logging.js";
import { PROJECT_ROOT } from "./paths.js";

export type FailureKind =
  | "login_redirect"
  | "profile_lock"
  | "selector_miss"
  | "zero_batch"
  | "missing_auth"
  | "safety_limit"
  | "linkedin_restriction"
  | "unknown";

export type ClassifiedFailure = {
  kind: FailureKind;
  message: string;
  retriable: boolean;
};

const SAFETY_LIMIT_RE =
  /SafetyLimitError|LinkedIn safety:|daily \w+ cap reached|job runtime exceeded/i;

const RESTRICTION_RE =
  /LinkedInRestrictionError|restriction\/checkpoint|unusual activity|account-restricted|cool down|Do not re-run aggressively|Do not retry in a loop/i;

/** Plain missing session / bounced to login — may recover after auth:linkedin. */
const LOGIN_RE =
  /redirected to login|not authenticated|run `?npm run auth:linkedin/i;

const PROFILE_LOCK_RE =
  /existing browser session|user data dir|profile is already in use|SingletonLock|ProfileBusyError|already in use by another job|LinkedIn lock busy|Only one LinkedIn job|Target page, context or browser has been closed/i;

const SELECTOR_RE =
  /label_not_found|not found in modal|Invite\/Send button not found|Invite to follow control not found|Could not parse invite credits|No invitable connections|row_visible_not_checkable|selector|locator\.click|Timeout .* exceeded/i;

const ZERO_BATCH_RE =
  /No invitation credits left|Computed batch is 0|Nothing to send today|nothing_to_send/i;

const MISSING_AUTH_RE = /Missing LinkedIn session|auth\/linkedin\.json/i;

export function classifyFailure(error: unknown): ClassifiedFailure {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";

  if (
    name === "SafetyLimitError" ||
    code === "SAFETY_LIMIT" ||
    SAFETY_LIMIT_RE.test(message)
  ) {
    return { kind: "safety_limit", message, retriable: false };
  }
  if (
    name === "LinkedInRestrictionError" ||
    code === "LINKEDIN_RESTRICTION" ||
    RESTRICTION_RE.test(message)
  ) {
    return { kind: "linkedin_restriction", message, retriable: false };
  }
  if (ZERO_BATCH_RE.test(message)) {
    return { kind: "zero_batch", message, retriable: false };
  }
  if (MISSING_AUTH_RE.test(message)) {
    return { kind: "missing_auth", message, retriable: true };
  }
  // Checkpoint/challenge in message without auth hint → cool down, no retry
  if (
    /checkpoint|captcha|authwall|security-verification|\/challenge/i.test(
      message,
    ) &&
    !/Run `?npm run auth:linkedin`/i.test(message)
  ) {
    return { kind: "linkedin_restriction", message, retriable: false };
  }
  if (LOGIN_RE.test(message) || /login\/checkpoint/i.test(message)) {
    return { kind: "login_redirect", message, retriable: true };
  }
  if (
    name === "ProfileBusyError" ||
    code === "PROFILE_BUSY" ||
    PROFILE_LOCK_RE.test(message)
  ) {
    return { kind: "profile_lock", message, retriable: true };
  }
  if (SELECTOR_RE.test(message)) {
    return { kind: "selector_miss", message, retriable: true };
  }
  return { kind: "unknown", message, retriable: false };
}

function healDefaults(job: JobDefinition): Required<
  Pick<
    JobHealConfig,
    | "reauthOnLoginRedirect"
    | "retryOnProfileLock"
    | "retryOnSelectorMiss"
    | "softExitOnZeroBatch"
    | "maxRetries"
    | "authCommand"
    | "profilePath"
  >
> {
  const h = job.heal ?? {};
  return {
    reauthOnLoginRedirect: h.reauthOnLoginRedirect ?? true,
    retryOnProfileLock: h.retryOnProfileLock ?? true,
    retryOnSelectorMiss: h.retryOnSelectorMiss ?? true,
    softExitOnZeroBatch: h.softExitOnZeroBatch ?? true,
    maxRetries: h.maxRetries ?? 1,
    authCommand: h.authCommand ?? "auth:linkedin",
    profilePath: h.profilePath ?? ".pw-user-data/linkedin",
  };
}

/**
 * Kill Chromium/Chrome processes whose command line references our profile dir.
 * Windows-first; best-effort elsewhere. Only matches our profile path.
 */
export function releaseProfileLock(profileRelPath: string): {
  killed: number;
  removedLock: boolean;
  detail: string;
} {
  const profileAbs = path.resolve(PROJECT_ROOT, profileRelPath);
  let killed = 0;
  const details: string[] = [];

  if (process.platform === "win32") {
    try {
      const ps = `
$needle = ${JSON.stringify(profileAbs.replace(/\//g, "\\"))};
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -match '^(chrome|chromium|msedge)\\.exe$' -and
    $_.CommandLine -and
    $_.CommandLine -like ("*" + $needle + "*")
  };
$n = 0;
foreach ($p in $procs) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop;
    $n++
  } catch {}
}
Write-Output $n
`.trim();
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { encoding: "utf8", timeout: 15_000 },
      ).trim();
      killed = Number(out) || 0;
      details.push(`killed=${killed}`);
    } catch (err) {
      details.push(
        `kill_failed=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    try {
      execFileSync("pkill", ["-f", profileAbs], {
        timeout: 10_000,
        stdio: "ignore",
      });
      killed = 1;
      details.push("pkill_attempted");
    } catch {
      details.push("pkill_noop");
    }
  }

  let removedLock = false;
  for (const lockName of [
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
  ]) {
    const lockPath = path.join(profileAbs, lockName);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        removedLock = true;
        details.push(`removed=${lockName}`);
      } catch {
        details.push(`lock_busy=${lockName}`);
      }
    }
  }

  return { killed, removedLock, detail: details.join("; ") };
}

export type HealDecision =
  | { action: "soft_success"; message: string }
  | { action: "retry"; message: string; hint?: string }
  | { action: "abort"; message: string; hint?: string };

/**
 * Decide heal action for a classified failure given job heal config + attempt #.
 */
export function decideHeal(
  job: JobDefinition,
  failure: ClassifiedFailure,
  attempt: number,
): HealDecision {
  const cfg = healDefaults(job);
  const canRetry = attempt < cfg.maxRetries;

  if (failure.kind === "zero_batch" && cfg.softExitOnZeroBatch) {
    return {
      action: "soft_success",
      message: failure.message || "Nothing to send (zero batch / no credits).",
    };
  }

  // Daily caps / job runtime — clean soft exit, never retry
  if (failure.kind === "safety_limit") {
    return {
      action: "soft_success",
      message:
        failure.message ||
        "LinkedIn daily safety cap reached. Partial work is OK; continue tomorrow.",
    };
  }

  // Restriction / checkpoint / unusual activity — abort, do NOT auto-retry
  if (failure.kind === "linkedin_restriction") {
    return {
      action: "abort",
      message: failure.message,
      hint:
        "Cool down 24–48h. Browse LinkedIn manually in a headed browser before any automation. Do not loop retries.",
    };
  }

  if (
    (failure.kind === "login_redirect" || failure.kind === "missing_auth") &&
    cfg.reauthOnLoginRedirect
  ) {
    const hint =
      `Session missing or expired. Run \`npm run ${cfg.authCommand}\`, ` +
      "complete 2FA if prompted, then re-run this job. " +
      "Runner retries once if auth state appears after a brief wait.";
    if (canRetry) {
      return { action: "retry", message: failure.message, hint };
    }
    return { action: "abort", message: failure.message, hint };
  }

  // Exclusive LinkedIn job.lock — abort immediately (do not kill Chromium / do not retry)
  if (
    failure.kind === "profile_lock" &&
    /LinkedIn lock busy|Only one LinkedIn job|already in use by another job|ProfileBusyError/i.test(
      failure.message,
    )
  ) {
    return {
      action: "abort",
      message: failure.message,
      hint:
        "Another LinkedIn job holds the lock. Wait for it to finish, then retry. Lock file: data/linkedin-safety/job.lock",
    };
  }

  if (failure.kind === "profile_lock" && cfg.retryOnProfileLock && canRetry) {
    const released = releaseProfileLock(cfg.profilePath);
    return {
      action: "retry",
      message: failure.message,
      hint: `Released profile lock (${released.detail}). Retrying once.`,
    };
  }

  if (failure.kind === "selector_miss" && cfg.retryOnSelectorMiss && canRetry) {
    return {
      action: "retry",
      message: failure.message,
      hint:
        "Selector/UI miss — retrying once (job uses alternate locator strategies).",
    };
  }

  return {
    action: "abort",
    message: failure.message,
    hint:
      failure.kind === "profile_lock"
        ? `Close other Chromium windows using ${cfg.profilePath}, then retry.`
        : undefined,
  };
}

export function openHealLogger(jobId: string): LogWriter {
  return createJsonlLogger(healLogPath(jobId), (e) =>
    e.message
      ? String(e.message)
      : e.action
        ? String(e.action)
        : e.kind
          ? String(e.kind)
          : "",
  );
}

export function logHealEvent(
  writer: LogWriter,
  event: {
    type: string;
    jobId: string;
    attempt?: number;
    kind?: FailureKind;
    action?: string;
    message?: string;
    hint?: string;
    [key: string]: unknown;
  },
): void {
  writer.log({
    ts: new Date().toISOString(),
    ...event,
  });
}

/**
 * After login failure: wait briefly for auth artifacts (user re-authed).
 * Single short poll window — does not block forever.
 */
export async function waitForAuthArtifacts(
  paths: string[],
  timeoutMs = 8_000,
  pollMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.some((p) => fs.existsSync(p))) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return paths.some((p) => fs.existsSync(p));
}

export { healLogPath };
