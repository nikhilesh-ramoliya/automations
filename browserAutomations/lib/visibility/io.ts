import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import {
  VISIBILITY_ARTIFACTS,
  type EngagementRecord,
  type FoundPost,
  type PostDraft,
  type TargetPerson,
  type VisibilityRunConfigSnapshot,
  type VisibilityRunMeta,
} from "./types.js";

export const VISIBILITY_DATA_DIR = path.join(PROJECT_ROOT, "data", "visibility");
export const VISIBILITY_OUTPUT_DIR = path.join(
  PROJECT_ROOT,
  "output",
  "visibility",
);

export function createRunId(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function getLatestVisibilityRunId(): string | undefined {
  if (!fs.existsSync(VISIBILITY_DATA_DIR)) return undefined;
  const dirs = fs
    .readdirSync(VISIBILITY_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : undefined;
}

export function resolveVisibilityRunDir(options?: {
  createIfMissing?: boolean;
}): { runId: string; runDir: string } {
  const explicit = process.env.VISIBILITY_RUN_ID?.trim();
  if (explicit) {
    const runDir = path.join(VISIBILITY_DATA_DIR, explicit);
    fs.mkdirSync(runDir, { recursive: true });
    return { runId: explicit, runDir };
  }

  if (options?.createIfMissing) {
    const runId = createRunId();
    const runDir = path.join(VISIBILITY_DATA_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    process.env.VISIBILITY_RUN_ID = runId;
    return { runId, runDir };
  }

  const latest = getLatestVisibilityRunId();
  if (!latest) {
    throw new Error(
      "No visibility run found. Set VISIBILITY_RUN_ID or run visibility-find-posts first.",
    );
  }
  const runDir = path.join(VISIBILITY_DATA_DIR, latest);
  process.env.VISIBILITY_RUN_ID = latest;
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

export function ensureVisibilityMeta(
  runDir: string,
  runId: string,
  config: VisibilityRunConfigSnapshot,
  step?: string,
): VisibilityRunMeta {
  const metaPath = artifactPath(runDir, VISIBILITY_ARTIFACTS.meta);
  const existing = readJson<VisibilityRunMeta>(metaPath);
  const now = new Date().toISOString();
  const meta: VisibilityRunMeta = existing
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
        purpose: "visibility",
        config,
        stepsCompleted: [],
      };

  if (step && !meta.stepsCompleted.includes(step)) {
    meta.stepsCompleted.push(step);
  }
  writeJson(metaPath, meta);
  return meta;
}

export function markVisibilityStep(runDir: string, step: string): void {
  const metaPath = artifactPath(runDir, VISIBILITY_ARTIFACTS.meta);
  const meta = readJson<VisibilityRunMeta>(metaPath);
  if (!meta) return;
  if (!meta.stepsCompleted.includes(step)) {
    meta.stepsCompleted.push(step);
  }
  meta.updatedAt = new Date().toISOString();
  writeJson(metaPath, meta);
}

export function loadPosts(runDir: string): FoundPost[] {
  return (
    readJson<FoundPost[]>(artifactPath(runDir, VISIBILITY_ARTIFACTS.posts)) ??
    []
  );
}

export function loadEngagements(runDir: string): EngagementRecord[] {
  return (
    readJson<EngagementRecord[]>(
      artifactPath(runDir, VISIBILITY_ARTIFACTS.engagements),
    ) ?? []
  );
}

export function loadTargets(runDir: string): TargetPerson[] {
  return (
    readJson<TargetPerson[]>(
      artifactPath(runDir, VISIBILITY_ARTIFACTS.targets),
    ) ?? []
  );
}

/** Profile URLs already visited/engaged in recent runs. */
export function loadRecentTargetProfileUrls(limitRuns = 8): Set<string> {
  const urls = new Set<string>();
  if (!fs.existsSync(VISIBILITY_DATA_DIR)) return urls;
  const dirs = fs
    .readdirSync(VISIBILITY_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .slice(-Math.max(1, limitRuns));
  for (const name of dirs) {
    for (const t of loadTargets(path.join(VISIBILITY_DATA_DIR, name))) {
      const u = normalizeUrl(t.profileUrl);
      if (u) urls.add(u);
    }
  }
  return urls;
}

/** Post IDs already engaged (reacted/commented) in recent runs — skip for uniqueness. */
export function loadRecentEngagedPostIds(limitRuns = 8): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(VISIBILITY_DATA_DIR)) return ids;
  const dirs = fs
    .readdirSync(VISIBILITY_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .slice(-Math.max(1, limitRuns));
  for (const name of dirs) {
    const engagements = loadEngagements(path.join(VISIBILITY_DATA_DIR, name));
    for (const e of engagements) {
      if (e.postId && (e.reacted || e.commentSent || e.commentDrafted)) {
        ids.add(e.postId);
      }
    }
  }
  return ids;
}

export function loadDrafts(runDir: string): PostDraft[] {
  return (
    readJson<PostDraft[]>(artifactPath(runDir, VISIBILITY_ARTIFACTS.drafts)) ??
    []
  );
}

export function resolveVisibilityOutputDir(runId: string): string {
  const out = path.join(VISIBILITY_OUTPUT_DIR, runId);
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

export function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.trim());
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/+$/, "") || "";
    return `${u.protocol}//${host}${pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

export function postKey(p: Pick<FoundPost, "url" | "text">): string {
  const url = normalizeUrl(p.url);
  if (url) return `url:${url}`;
  return `text:${p.text.slice(0, 80).toLowerCase()}`;
}
