/** Env helpers for Naukri jobs. */

import fs from "node:fs";
import path from "node:path";
import type { NaukriRunConfigSnapshot } from "./types.js";

export function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return v === "true" || v === "1";
}

export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

export function envList(name: string, fallback: string[] = []): string[] {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const DEFAULT_NAUKRI_ROLES = [
  "Full Stack Developer",
  "MERN Stack Developer",
  "React Developer",
];

export const DEFAULT_NAUKRI_GEOS = ["Ahmedabad", "Bengaluru", "Pune"];

export const DEFAULT_NAUKRI_KEYWORDS = [
  "react",
  "mern",
  "node",
  "mongodb",
  "express",
  "full stack",
  "javascript",
  "typescript",
];

export function isNaukriDryRun(): boolean {
  return envBool("NAUKRI_DRY_RUN", envBool("DRY_RUN", true));
}

export function naukriRoles(): string[] {
  return envList("NAUKRI_ROLES", DEFAULT_NAUKRI_ROLES);
}

export function naukriGeos(): string[] {
  return envList("NAUKRI_GEOS", DEFAULT_NAUKRI_GEOS);
}

export function naukriKeywords(): string[] {
  return envList("NAUKRI_KEYWORDS", DEFAULT_NAUKRI_KEYWORDS);
}

export function naukriMaxJobs(): number {
  return envInt("NAUKRI_MAX_JOBS", 25);
}

export function naukriApplyMax(): number {
  return envInt("NAUKRI_APPLY_MAX", 10);
}

export function naukriDelayMs(): number {
  return envInt("NAUKRI_DELAY_MS", 2500);
}

/** Skip jobs that only offer "Apply on company website". Default true. */
export function naukriSkipExternalApply(): boolean {
  return envBool("NAUKRI_SKIP_EXTERNAL_APPLY", true);
}

const DEFAULT_RESUME_REL = path.join("data", "naukri", "resume.pdf");

/** Absolute path to resume PDF for ATS uploads (external apply). */
export function naukriResumePath(): string | null {
  const raw = process.env.NAUKRI_RESUME_PATH?.trim() || DEFAULT_RESUME_REL;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return fs.existsSync(abs) ? abs : null;
}

export function snapshotConfigFromEnv(): NaukriRunConfigSnapshot {
  return {
    roles: naukriRoles(),
    geos: naukriGeos(),
    keywords: naukriKeywords(),
    maxJobs: naukriMaxJobs(),
    dryRun: isNaukriDryRun(),
  };
}
