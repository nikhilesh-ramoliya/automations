/**
 * Personal content interests from instructions.md + usage rotation tracking.
 */

import fs from "node:fs";
import path from "node:path";
import { loadContentInstructions } from "./instructions.js";
import { CONTENT_DATA_DIR, readJson, writeJson } from "./io.js";

const USAGE_PATH = path.join(CONTENT_DATA_DIR, "interest-usage.json");

export type InterestUsageStore = {
  updatedAt: string;
  /** Normalized interest label → use count */
  counts: Record<string, number>;
  /** Recently used interest labels (normalized), newest last */
  recent: string[];
};

export function normalizeInterestLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Interests from instructions.md (original casing preserved). */
export function listInterests(
  loaded = loadContentInstructions(),
): string[] {
  return loaded.sections.interests
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadUsage(): InterestUsageStore {
  const data = readJson<InterestUsageStore>(USAGE_PATH);
  return (
    data ?? {
      updatedAt: new Date().toISOString(),
      counts: {},
      recent: [],
    }
  );
}

function saveUsage(store: InterestUsageStore): void {
  fs.mkdirSync(CONTENT_DATA_DIR, { recursive: true });
  writeJson(USAGE_PATH, store);
}

/**
 * Prefer underused / not-recent interests for the next research batch.
 * Returns original-cased labels from instructions.
 */
export function pickInterestsForRun(
  n: number,
  interests = listInterests(),
): string[] {
  if (!interests.length || n <= 0) return [];
  const usage = loadUsage();
  const recentSet = new Set(
    usage.recent.slice(-Math.max(interests.length * 2, 8)).map(normalizeInterestLabel),
  );

  const ranked = [...interests].sort((a, b) => {
    const na = normalizeInterestLabel(a);
    const nb = normalizeInterestLabel(b);
    const countDiff = (usage.counts[na] ?? 0) - (usage.counts[nb] ?? 0);
    if (countDiff !== 0) return countDiff;
    const aRecent = recentSet.has(na) ? 1 : 0;
    const bRecent = recentSet.has(nb) ? 1 : 0;
    if (aRecent !== bRecent) return aRecent - bRecent;
    return a.localeCompare(b);
  });

  const picked: string[] = [];
  for (const label of ranked) {
    if (picked.length >= n) break;
    picked.push(label);
  }
  // If asking for more topics than interests, cycle the ranked list
  while (picked.length < n && ranked.length) {
    picked.push(ranked[picked.length % ranked.length]!);
  }
  return picked;
}

/** Record that these interests were used (topics or drafts). */
export function recordInterestUse(labels: string[]): void {
  const cleaned = labels.map((l) => l.trim()).filter(Boolean);
  if (!cleaned.length) return;
  const store = loadUsage();
  for (const label of cleaned) {
    const key = normalizeInterestLabel(label);
    if (!key) continue;
    store.counts[key] = (store.counts[key] ?? 0) + 1;
    store.recent.push(key);
  }
  store.recent = store.recent.slice(-40);
  store.updatedAt = new Date().toISOString();
  saveUsage(store);
}

function tokenRelated(a: string, b: string): boolean {
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const stem = (s: string) => s.replace(/(ing|ers|ies|es|s)$/i, "");
  const sa = stem(a);
  const sb = stem(b);
  if (sa.length < 3 || sb.length < 3) return false;
  return sa === sb || sa.startsWith(sb) || sb.startsWith(sa);
}

/**
 * Best-matching interest for free text, or undefined if none score well.
 * Matching uses whole-label inclusion and significant token overlap.
 */
export function matchInterest(
  text: string,
  interests = listInterests(),
): string | undefined {
  if (!text.trim() || !interests.length) return undefined;
  const hay = normalizeInterestLabel(text);
  const hayTokens = hay.split(" ").filter(Boolean);
  let best: { label: string; score: number } | undefined;

  for (const label of interests) {
    const norm = normalizeInterestLabel(label);
    if (!norm) continue;
    let score = 0;
    if (hay.includes(norm)) {
      score += 10;
    }
    const tokens = norm.split(" ").filter((t) => t.length >= 2);
    const hits = tokens.filter((t) => {
      if (hay.includes(t)) return true;
      return hayTokens.some((h) => tokenRelated(h, t));
    }).length;
    if (tokens.length) {
      score += (hits / tokens.length) * 6;
    }
    if (tokens.length >= 2 && hits === tokens.length) score += 3;
    if (!best || score > best.score) best = { label, score };
  }

  if (!best || best.score < 3) return undefined;
  return best.label;
}

/** Resolve an interest label against the known list (fuzzy). */
export function resolveInterestLabel(
  raw: string | undefined,
  interests = listInterests(),
): string | undefined {
  if (!raw?.trim()) return undefined;
  const norm = normalizeInterestLabel(raw);
  const exact = interests.find((i) => normalizeInterestLabel(i) === norm);
  if (exact) return exact;
  return matchInterest(raw, interests);
}
