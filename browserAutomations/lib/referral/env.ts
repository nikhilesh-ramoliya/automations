/** Shared env helpers for referral (job hunt) jobs. */

import type { ReferralRunConfigSnapshot } from "./types.js";

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

export const DEFAULT_REFERRAL_ROLES = [
  "Full Stack Developer",
  "MERN Stack Developer",
  "React Developer",
];

export const DEFAULT_REFERRAL_GEOS = ["Ahmedabad", "Bengaluru", "Pune"];

export const DEFAULT_REFERRAL_JD_KEYWORDS = [
  "react",
  "mern",
  "node",
  "mongodb",
  "express",
  "full stack",
  "javascript",
  "typescript",
];

export function isReferralDryRun(): boolean {
  return envBool("REFERRAL_DRY_RUN", envBool("DRY_RUN", true));
}

export function referralRoles(): string[] {
  return envList("REFERRAL_ROLES", DEFAULT_REFERRAL_ROLES);
}

export function referralGeos(): string[] {
  return envList("REFERRAL_GEOS", DEFAULT_REFERRAL_GEOS);
}

export function referralJdKeywords(): string[] {
  return envList("REFERRAL_JD_KEYWORDS", DEFAULT_REFERRAL_JD_KEYWORDS);
}

export function referralMaxJobs(): number {
  return envInt("REFERRAL_MAX_JOBS", 25);
}

export function referralMaxPeoplePerCompany(): number {
  return envInt("REFERRAL_MAX_PEOPLE_PER_COMPANY", 3);
}

export function referralMaxRecruitersPerCompany(): number {
  return envInt("REFERRAL_MAX_RECRUITERS_PER_COMPANY", 2);
}

export function referralDelayMs(): number {
  return envInt("REFERRAL_DELAY_MS", 2000);
}

export function snapshotConfigFromEnv(): ReferralRunConfigSnapshot {
  return {
    roles: referralRoles(),
    geos: referralGeos(),
    jdKeywords: referralJdKeywords(),
    maxJobs: referralMaxJobs(),
    maxPeoplePerCompany: referralMaxPeoplePerCompany(),
    dryRun: isReferralDryRun(),
  };
}
