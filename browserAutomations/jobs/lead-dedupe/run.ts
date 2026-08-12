import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import { isLeadDryRun, snapshotConfigFromEnv } from "../../lib/leads/env.js";
import {
  artifactPath,
  ensureRunMeta,
  loadCompanies,
  loadPeople,
  normalizeCompanyName,
  normalizeUrl,
  resolveCompaniesArtifactPath,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";
import { ARTIFACTS, type CompanyRecord, type PersonRecord } from "../../lib/leads/types.js";

function companyKey(c: CompanyRecord): string {
  const url = normalizeUrl(c.linkedinUrl) || normalizeUrl(c.websiteUrl);
  if (url) return `url:${url}`;
  return `name:${c.normalizedName || normalizeCompanyName(c.name)}`;
}

function personKey(p: PersonRecord): string {
  const url = normalizeUrl(p.linkedinUrl);
  if (url) return `url:${url}`;
  return `name:${p.name.toLowerCase().trim()}|co:${p.companyId}`;
}

function dedupeCompanies(list: CompanyRecord[]): {
  kept: CompanyRecord[];
  removed: number;
} {
  const map = new Map<string, CompanyRecord>();
  let removed = 0;
  for (const c of list) {
    const key = companyKey(c);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, c);
      continue;
    }
    removed += 1;
    // Merge sparse fields into first
    map.set(key, {
      ...existing,
      linkedinUrl: existing.linkedinUrl || c.linkedinUrl,
      websiteUrl: existing.websiteUrl || c.websiteUrl,
      industry: existing.industry || c.industry,
      location: existing.location || c.location,
      description: existing.description || c.description,
      about: existing.about || c.about,
      notes: [...(existing.notes ?? []), ...(c.notes ?? []), `merged:${c.id}`],
    });
  }
  return { kept: [...map.values()], removed };
}

function dedupePeople(list: PersonRecord[]): {
  kept: PersonRecord[];
  removed: number;
} {
  const map = new Map<string, PersonRecord>();
  let removed = 0;
  for (const p of list) {
    const key = personKey(p);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, p);
      continue;
    }
    removed += 1;
    map.set(key, {
      ...existing,
      title: existing.title || p.title,
      email: existing.email || p.email,
      location: existing.location || p.location,
      linkedinUrl: existing.linkedinUrl || p.linkedinUrl,
    });
  }
  return { kept: [...map.values()], removed };
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isLeadDryRun();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-dedupe");
  const writer = createJsonlLogger(logPath);

  const companies = loadCompanies(runDir, "best");
  const people = loadPeople(runDir);

  const co = dedupeCompanies(companies);
  const pe = dedupePeople(people);

  writer.log({
    ts: new Date().toISOString(),
    type: "dedupe",
    runId,
    dryRun,
    companiesBefore: companies.length,
    companiesAfter: co.kept.length,
    companiesRemoved: co.removed,
    peopleBefore: people.length,
    peopleAfter: pe.kept.length,
    peopleRemoved: pe.removed,
  });

  // Write back to the most advanced companies artifact present, else base.
  // Do not clobber base when updating an advanced (possibly empty) file.
  const basePath = artifactPath(runDir, ARTIFACTS.companies);
  const outCompanies = resolveCompaniesArtifactPath(runDir);
  writeJson(outCompanies, co.kept);
  if (outCompanies === basePath) {
    writeJson(basePath, co.kept);
  } else if (co.kept.length > 0) {
    // Keep base in sync only when we still have companies
    writeJson(basePath, co.kept);
  }
  if (people.length || pe.kept.length) {
    writeJson(artifactPath(runDir, ARTIFACTS.people), pe.kept);
  }

  ensureRunMeta(runDir, runId, config, "lead-dedupe");
  console.log(
    `Dedupe run ${runId}: companies ${companies.length}→${co.kept.length}, people ${people.length}→${pe.kept.length}`,
  );
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  return {
    exitCode: 0,
    message: `Removed ${co.removed} companies, ${pe.removed} people`,
  };
}
