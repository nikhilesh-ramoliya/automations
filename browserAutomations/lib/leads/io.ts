import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import {
  ARTIFACTS,
  type CompanyRecord,
  type LeadRunConfigSnapshot,
  type LeadWithOutreach,
  type PersonRecord,
  type QualifiedLead,
  type RunMeta,
} from "./types.js";

export const LEADS_DATA_DIR = path.join(PROJECT_ROOT, "data", "leads");
export const LEADS_OUTPUT_DIR = path.join(PROJECT_ROOT, "output", "leads");
export const LEADS_SUPPRESS_DIR = path.join(LEADS_DATA_DIR, "suppress");

export function createRunId(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function getLatestRunId(): string | undefined {
  if (!fs.existsSync(LEADS_DATA_DIR)) return undefined;
  const dirs = fs
    .readdirSync(LEADS_DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "suppress")
    .map((d) => d.name)
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : undefined;
}

/**
 * Resolve `data/leads/<runId>/`.
 * - If LEAD_RUN_ID is set, use it.
 * - Else if createIfMissing, mint a new timestamp id (discover).
 * - Else use latest existing run.
 */
export function resolveRunDir(options?: {
  createIfMissing?: boolean;
}): { runId: string; runDir: string } {
  const explicit = process.env.LEAD_RUN_ID?.trim();
  if (explicit) {
    const runDir = path.join(LEADS_DATA_DIR, explicit);
    fs.mkdirSync(runDir, { recursive: true });
    return { runId: explicit, runDir };
  }

  if (options?.createIfMissing) {
    const runId = createRunId();
    const runDir = path.join(LEADS_DATA_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    process.env.LEAD_RUN_ID = runId;
    return { runId, runDir };
  }

  const latest = getLatestRunId();
  if (!latest) {
    throw new Error(
      "No lead run found. Set LEAD_RUN_ID or run lead-discover-companies first.",
    );
  }
  const runDir = path.join(LEADS_DATA_DIR, latest);
  process.env.LEAD_RUN_ID = latest;
  return { runId: latest, runDir };
}

export function artifactPath(runDir: string, name: string): string {
  return path.join(runDir, name);
}

export function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

/** Read companies JSON; treat missing or empty [] as absent (fall through). */
function readCompaniesIfNonEmpty(filePath: string): CompanyRecord[] | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const data = readJson<CompanyRecord[]>(filePath);
  if (!data || data.length === 0) return undefined;
  return data;
}

/**
 * Most advanced non-empty companies artifact path (tech → enriched → base).
 * Empty [] advanced files (failed enrich wipe) do not shadow base companies.json.
 */
export function resolveCompaniesArtifactPath(runDir: string): string {
  const tech = artifactPath(runDir, ARTIFACTS.companiesTech);
  const enriched = artifactPath(runDir, ARTIFACTS.companiesEnriched);
  const base = artifactPath(runDir, ARTIFACTS.companies);
  if (readCompaniesIfNonEmpty(tech)) return tech;
  if (readCompaniesIfNonEmpty(enriched)) return enriched;
  return base;
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function ensureRunMeta(
  runDir: string,
  runId: string,
  config: LeadRunConfigSnapshot,
  step?: string,
): RunMeta {
  const metaPath = artifactPath(runDir, ARTIFACTS.meta);
  const existing = readJson<RunMeta>(metaPath);
  const now = new Date().toISOString();
  const meta: RunMeta = existing
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
        config,
        stepsCompleted: [],
      };

  if (step && !meta.stepsCompleted.includes(step)) {
    meta.stepsCompleted.push(step);
  }
  writeJson(metaPath, meta);
  return meta;
}

export function markStep(runDir: string, step: string): void {
  const metaPath = artifactPath(runDir, ARTIFACTS.meta);
  const meta = readJson<RunMeta>(metaPath);
  if (!meta) return;
  if (!meta.stepsCompleted.includes(step)) {
    meta.stepsCompleted.push(step);
  }
  meta.updatedAt = new Date().toISOString();
  writeJson(metaPath, meta);
}

/** Prefer enriched → tech → base companies file. Skips empty [] advanced artifacts. */
export function loadCompanies(
  runDir: string,
  prefer: "base" | "enriched" | "tech" | "best" = "best",
): CompanyRecord[] {
  const base = artifactPath(runDir, ARTIFACTS.companies);
  const enriched = artifactPath(runDir, ARTIFACTS.companiesEnriched);
  const tech = artifactPath(runDir, ARTIFACTS.companiesTech);

  if (prefer === "base") return readJson<CompanyRecord[]>(base) ?? [];
  if (prefer === "enriched") {
    return (
      readCompaniesIfNonEmpty(enriched) ??
      readJson<CompanyRecord[]>(base) ??
      []
    );
  }
  if (prefer === "tech") {
    return (
      readCompaniesIfNonEmpty(tech) ??
      readCompaniesIfNonEmpty(enriched) ??
      readJson<CompanyRecord[]>(base) ??
      []
    );
  }
  // "best": most advanced non-empty artifact (empty enriched/tech fall back to base)
  return (
    readCompaniesIfNonEmpty(tech) ??
    readCompaniesIfNonEmpty(enriched) ??
    readJson<CompanyRecord[]>(base) ??
    []
  );
}

export function loadPeople(runDir: string): PersonRecord[] {
  return (
    readJson<PersonRecord[]>(artifactPath(runDir, ARTIFACTS.people)) ?? []
  );
}

export function loadLeads(runDir: string): QualifiedLead[] {
  return readJson<QualifiedLead[]>(artifactPath(runDir, ARTIFACTS.leads)) ?? [];
}

export function loadLeadsOutreach(runDir: string): LeadWithOutreach[] {
  return (
    readJson<LeadWithOutreach[]>(
      artifactPath(runDir, ARTIFACTS.leadsOutreach),
    ) ?? []
  );
}

export function resolveOutputDir(runId: string): string {
  const out = path.join(LEADS_OUTPUT_DIR, runId);
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

export function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|sa|bv)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.trim());
    u.hash = "";
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = u.pathname.replace(/\/+$/, "") || "";
    return `${u.protocol}//${host}${pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}
