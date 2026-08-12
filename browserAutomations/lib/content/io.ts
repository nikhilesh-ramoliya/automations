import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import {
  CONTENT_ARTIFACTS,
  type ContentDraft,
  type ContentRunConfigSnapshot,
  type ContentRunMeta,
  type ContentTopic,
} from "./types.js";

export const CONTENT_DATA_DIR = path.join(PROJECT_ROOT, "data", "content");
export const CONTENT_OUTPUT_DIR = path.join(PROJECT_ROOT, "output", "content");

export function createRunId(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function getLatestContentRunId(): string | undefined {
  if (!fs.existsSync(CONTENT_DATA_DIR)) return undefined;
  const dirs = fs
    .readdirSync(CONTENT_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : undefined;
}

export function resolveContentRunDir(options?: {
  createIfMissing?: boolean;
}): { runId: string; runDir: string } {
  const explicit = process.env.CONTENT_RUN_ID?.trim();
  if (explicit) {
    const runDir = path.join(CONTENT_DATA_DIR, explicit);
    fs.mkdirSync(runDir, { recursive: true });
    return { runId: explicit, runDir };
  }

  if (options?.createIfMissing) {
    const runId = createRunId();
    const runDir = path.join(CONTENT_DATA_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    process.env.CONTENT_RUN_ID = runId;
    return { runId, runDir };
  }

  const latest = getLatestContentRunId();
  if (!latest) {
    throw new Error(
      "No content run found. Set CONTENT_RUN_ID or run content-research-topics first.",
    );
  }
  const runDir = path.join(CONTENT_DATA_DIR, latest);
  process.env.CONTENT_RUN_ID = latest;
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

export function ensureContentMeta(
  runDir: string,
  runId: string,
  config: ContentRunConfigSnapshot,
  step?: string,
): ContentRunMeta {
  const metaPath = artifactPath(runDir, CONTENT_ARTIFACTS.meta);
  const existing = readJson<ContentRunMeta>(metaPath);
  const now = new Date().toISOString();
  const meta: ContentRunMeta = existing
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
        purpose: "content",
        config,
        stepsCompleted: [],
      };

  if (step && !meta.stepsCompleted.includes(step)) {
    meta.stepsCompleted.push(step);
  }
  writeJson(metaPath, meta);
  return meta;
}

export function markContentStep(runDir: string, step: string): void {
  const metaPath = artifactPath(runDir, CONTENT_ARTIFACTS.meta);
  const meta = readJson<ContentRunMeta>(metaPath);
  if (!meta) return;
  if (!meta.stepsCompleted.includes(step)) {
    meta.stepsCompleted.push(step);
  }
  meta.updatedAt = new Date().toISOString();
  writeJson(metaPath, meta);
}

export function loadTopics(runDir: string): ContentTopic[] {
  return (
    readJson<ContentTopic[]>(
      artifactPath(runDir, CONTENT_ARTIFACTS.topics),
    ) ?? []
  );
}

export function loadDrafts(runDir: string): ContentDraft[] {
  return (
    readJson<ContentDraft[]>(
      artifactPath(runDir, CONTENT_ARTIFACTS.drafts),
    ) ?? []
  );
}

export function resolveContentOutputDir(runId: string): string {
  const out = path.join(CONTENT_OUTPUT_DIR, runId);
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
