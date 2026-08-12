/** Env helpers for LinkedIn content engine jobs (`CONTENT_*`). */

import { isAiAvailable } from "../ai/client.js";
import {
  DEFAULT_CONTENT_AUDIENCES,
  DEFAULT_CONTENT_CATEGORIES,
  type ContentRunConfigSnapshot,
} from "./types.js";

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

export function isContentDryRun(): boolean {
  return envBool("CONTENT_DRY_RUN", envBool("DRY_RUN", true));
}

/** Prefer Cursor (CURSOR_API_KEY) or OpenAI-compatible key. Set CONTENT_USE_AI=false to disable. */
export function contentUseAi(): boolean {
  if (!envBool("CONTENT_USE_AI", true)) return false;
  return isAiAvailable();
}

export function contentCategories(): string[] {
  return envList("CONTENT_CATEGORIES", [...DEFAULT_CONTENT_CATEGORIES]);
}

export function contentAudiences(): string[] {
  return envList("CONTENT_AUDIENCES", [...DEFAULT_CONTENT_AUDIENCES]);
}

export function contentBrandName(): string {
  return process.env.CONTENT_BRAND_NAME?.trim() || "Lanatus";
}

export function snapshotContentConfigFromEnv(): ContentRunConfigSnapshot {
  return {
    maxTopics: envInt("CONTENT_MAX_TOPICS", 8),
    maxVariations: envInt("CONTENT_MAX_VARIATIONS", 4),
    minScore: envInt("CONTENT_MIN_SCORE", 55),
    categories: contentCategories(),
    audiences: contentAudiences(),
    dryRun: isContentDryRun(),
    aiEnabled: contentUseAi(),
  };
}
