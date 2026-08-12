/**
 * Uniqueness helpers: avoid near-duplicate drafts and recently used topics.
 */

import fs from "node:fs";
import path from "node:path";
import { CONTENT_DATA_DIR, loadDrafts, readJson, writeJson } from "./io.js";
import type { ContentDraft } from "./types.js";

const RECENT_PATH = path.join(CONTENT_DATA_DIR, "recent-fingerprints.json");

type RecentStore = {
  updatedAt: string;
  /** Normalized topic titles used recently */
  topics: string[];
  /** Content fingerprints (first ~12 significant tokens hash-ish) */
  fingerprints: string[];
};

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .split(" ")
      .filter((t) => t.length > 3),
  );
}

/** Jaccard similarity 0–1 on word tokens. */
export function contentSimilarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function contentFingerprint(content: string): string {
  return normalizeText(content).split(" ").filter((t) => t.length > 3).slice(0, 24).join(" ");
}

function loadRecent(): RecentStore {
  const data = readJson<RecentStore>(RECENT_PATH);
  return (
    data ?? {
      updatedAt: new Date().toISOString(),
      topics: [],
      fingerprints: [],
    }
  );
}

export function recentTopicTitles(limit = 24): Set<string> {
  const recent = loadRecent();
  // Also scan last few run drafts
  const titles = new Set(recent.topics.map((t) => t.toLowerCase()));
  if (!fs.existsSync(CONTENT_DATA_DIR)) return titles;
  const dirs = fs
    .readdirSync(CONTENT_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .slice(-6);
  for (const name of dirs) {
    for (const d of loadDrafts(path.join(CONTENT_DATA_DIR, name))) {
      titles.add(d.topic.toLowerCase());
      if (titles.size >= limit) break;
    }
  }
  return titles;
}

export function recentFingerprints(limit = 40): string[] {
  const recent = loadRecent().fingerprints.slice(-limit);
  if (!fs.existsSync(CONTENT_DATA_DIR)) return recent;
  const dirs = fs
    .readdirSync(CONTENT_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .slice(-4);
  const fps = [...recent];
  for (const name of dirs) {
    for (const d of loadDrafts(path.join(CONTENT_DATA_DIR, name))) {
      fps.push(contentFingerprint(d.content));
    }
  }
  return fps.slice(-limit);
}

/** Drop drafts that are too similar to each other or to recent posts. */
export function dedupeDrafts(
  drafts: ContentDraft[],
  opts?: { maxSimilarity?: number },
): ContentDraft[] {
  const maxSim = opts?.maxSimilarity ?? 0.55;
  const recent = recentFingerprints();
  const kept: ContentDraft[] = [];

  for (const d of drafts) {
    const tooCloseRecent = recent.some(
      (fp) => contentSimilarity(d.content, fp) >= maxSim,
    );
    if (tooCloseRecent) {
      console.log(
        `[content] Skipping near-duplicate of a recent post: ${d.angle} / ${d.topic.slice(0, 48)}`,
      );
      continue;
    }
    const tooCloseKept = kept.some(
      (k) => contentSimilarity(d.content, k.content) >= maxSim,
    );
    if (tooCloseKept) {
      console.log(
        `[content] Skipping near-duplicate within run: ${d.angle} / ${d.topic.slice(0, 48)}`,
      );
      continue;
    }
    kept.push(d);
  }
  return kept;
}

export function recordPublishedOrDrafted(drafts: ContentDraft[]): void {
  const store = loadRecent();
  for (const d of drafts) {
    store.topics.push(d.topic.toLowerCase());
    store.fingerprints.push(contentFingerprint(d.content));
  }
  store.topics = [...new Set(store.topics)].slice(-40);
  store.fingerprints = store.fingerprints.slice(-60);
  store.updatedAt = new Date().toISOString();
  fs.mkdirSync(CONTENT_DATA_DIR, { recursive: true });
  writeJson(RECENT_PATH, store);
}
