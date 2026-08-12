/** Env helpers for visibility / personal-profile marketing jobs (`VISIBILITY_*`). */

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import type { VisibilityRunConfigSnapshot } from "./types.js";

const LAST_KEYWORD_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "visibility",
  "last-search-keyword.json",
);

function readLastKeyword(): string | undefined {
  try {
    if (!fs.existsSync(LAST_KEYWORD_PATH)) return undefined;
    const data = JSON.parse(fs.readFileSync(LAST_KEYWORD_PATH, "utf8")) as {
      keyword?: string;
    };
    return data.keyword?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeLastKeyword(keyword: string): void {
  try {
    fs.mkdirSync(path.dirname(LAST_KEYWORD_PATH), { recursive: true });
    fs.writeFileSync(
      LAST_KEYWORD_PATH,
      JSON.stringify(
        { keyword, at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch {
    // non-fatal
  }
}

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

export function isVisibilityDryRun(): boolean {
  return envBool("VISIBILITY_DRY_RUN", envBool("DRY_RUN", true));
}

export function visibilityDelayMs(): number {
  return envInt("VISIBILITY_DELAY_MS", 2000);
}

/** Topics for content search + post drafts (personal brand visibility). */
export const DEFAULT_VISIBILITY_KEYWORDS = [
  "AI",
  "GenAI",
  "automation",
  "IT consulting",
  "custom software",
  "software engineering",
  "digital transformation",
  "RPA",
];

export function visibilityKeywords(): string[] {
  return envList("VISIBILITY_KEYWORDS", DEFAULT_VISIBILITY_KEYWORDS);
}

/**
 * Pick a random search term from the pool (avoids repeating the last term).
 * Default on — set VISIBILITY_RANDOM_SEARCH=false to search all keywords in order.
 */
export function pickRandomSearchKeyword(
  pool: string[] = visibilityKeywords(),
): string {
  const terms = pool.length ? pool : DEFAULT_VISIBILITY_KEYWORDS;
  const last =
    process.env.VISIBILITY_LAST_KEYWORD?.trim() || readLastKeyword();
  const candidates =
    terms.length > 1 && last
      ? terms.filter((t) => t.toLowerCase() !== last.toLowerCase())
      : terms;
  const pick =
    candidates[Math.floor(Math.random() * candidates.length)] ?? terms[0]!;
  process.env.VISIBILITY_LAST_KEYWORD = pick;
  writeLastKeyword(pick);
  return pick;
}

export function visibilitySearchKeywords(): string[] {
  if (envBool("VISIBILITY_RANDOM_SEARCH", true)) {
    return [pickRandomSearchKeyword(visibilityKeywords())];
  }
  return visibilityKeywords();
}

export function visibilityLikeMinScore(): number {
  return envInt("VISIBILITY_LIKE_MIN_SCORE", 55);
}

/** Comment only when relevance is high (default 75). */
export function visibilityCommentMinScore(): number {
  return envInt("VISIBILITY_COMMENT_MIN_SCORE", 75);
}

/** Connect only when software-dev lead-fit is this high (default 80). */
export function visibilityConnectMinLeadScore(): number {
  return envInt("VISIBILITY_CONNECT_MIN_LEAD_SCORE", 80);
}

/** ICP people-search queries for targeted engagement (titles / roles). */
export const DEFAULT_ICP_QUERIES = [
  "CTO software",
  "Founder SaaS",
  "VP Engineering",
  "Head of Engineering",
  "Engineering Manager",
  "Chief Technology Officer",
];

export function visibilityIcpQueries(): string[] {
  return envList("VISIBILITY_ICP_QUERIES", DEFAULT_ICP_QUERIES);
}

/**
 * Pick 1–N ICP queries for this run (random, avoid last).
 * VISIBILITY_ICP_QUERIES_PER_RUN default 1.
 */
export function pickIcpQueriesForRun(): string[] {
  const pool = visibilityIcpQueries();
  const n = Math.max(1, envInt("VISIBILITY_ICP_QUERIES_PER_RUN", 1));
  const last = process.env.VISIBILITY_LAST_ICP_QUERY?.trim() || readLastKeyword();
  const available =
    pool.length > 1 && last
      ? pool.filter((q) => q.toLowerCase() !== last.toLowerCase())
      : [...pool];
  const picked: string[] = [];
  const bag = [...available];
  while (picked.length < n && bag.length) {
    const i = Math.floor(Math.random() * bag.length);
    const q = bag.splice(i, 1)[0]!;
    picked.push(q);
  }
  if (picked[0]) {
    process.env.VISIBILITY_LAST_ICP_QUERY = picked[0];
    writeLastKeyword(picked[0]);
  }
  return picked;
}

export function snapshotVisibilityConfigFromEnv(): VisibilityRunConfigSnapshot {
  return {
    maxPosts: envInt("VISIBILITY_MAX_POSTS", 15),
    maxReactions: envInt("VISIBILITY_MAX_REACTIONS", 12),
    maxComments: envInt("VISIBILITY_MAX_COMMENTS", 6),
    maxDrafts: envInt("VISIBILITY_MAX_DRAFTS", 5),
    maxProfiles: envInt("VISIBILITY_MAX_PROFILES", 12),
    maxConnects: envInt("VISIBILITY_MAX_CONNECTS", 5),
    keywords: visibilityKeywords(),
    icpQueries: visibilityIcpQueries(),
    likeMinScore: visibilityLikeMinScore(),
    commentMinScore: visibilityCommentMinScore(),
    dryRun: isVisibilityDryRun(),
    mode: envBool("VISIBILITY_TARGETED", false)
      ? "targeted_people"
      : "keyword_posts",
  };
}
