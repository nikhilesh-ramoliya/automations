import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  envInt,
  isLeadDryRun,
  snapshotConfigFromEnv,
} from "../../lib/leads/env.js";
import { leadMinCompanyScore, passesLeadGate } from "../../lib/leads/company-quality.js";
import {
  ARTIFACTS,
  type LeadWithOutreach,
  type QualifiedLead,
} from "../../lib/leads/types.js";
import {
  ensureRunMeta,
  loadLeads,
  loadLeadsOutreach,
  resolveOutputDir,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";

function csvEscape(value: string | number | boolean | undefined | null): string {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toRows(leads: Array<QualifiedLead | LeadWithOutreach>): string {
  const headers = [
    "leadId",
    "score",
    "companyName",
    "personName",
    "personTitle",
    "recommendedService",
    "recommendedServiceLabel",
    "buyingSignals",
    "rationale",
    "companyLinkedIn",
    "companyWebsite",
    "personLinkedIn",
    "linkedinOutreach",
    "emailSubject",
    "emailBody",
  ];

  const lines = [headers.join(",")];
  for (const lead of leads) {
    const outreach = "outreach" in lead ? lead.outreach : undefined;
    const li = outreach?.find((o) => o.channel === "linkedin");
    const em = outreach?.find((o) => o.channel === "email");
    lines.push(
      [
        lead.id,
        lead.score,
        lead.companyName,
        lead.personName,
        lead.personTitle,
        lead.recommendedService,
        lead.recommendedServiceLabel,
        lead.buyingSignals.join("; "),
        lead.rationale,
        lead.company.linkedinUrl,
        lead.company.websiteUrl,
        lead.person?.linkedinUrl,
        li?.body,
        em?.subject,
        em?.body,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isLeadDryRun();
  const minScore = envInt("LEAD_MIN_SCORE", 60);
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-export");
  const writer = createJsonlLogger(logPath);

  const withOutreach = loadLeadsOutreach(runDir);
  const base = loadLeads(runDir);
  const leads: Array<QualifiedLead | LeadWithOutreach> =
    withOutreach.length > 0 ? withOutreach : base;
  const minCompanyScore = leadMinCompanyScore();
  const filtered = leads.filter((l) => {
    if (l.score < minScore) return false;
    const gate = passesLeadGate(l.company, minCompanyScore);
    if (!gate.pass) {
      writer.log({
        ts: new Date().toISOString(),
        type: "company_rejected",
        name: l.companyName,
        score: gate.score,
        reasons: gate.reasons,
        stage: "export",
      });
      return false;
    }
    return true;
  });

  const outDir = resolveOutputDir(runId);
  const exportDir = path.join(runDir, ARTIFACTS.exportDir);
  fs.mkdirSync(exportDir, { recursive: true });

  const jsonPath = path.join(outDir, "leads.json");
  const csvPath = path.join(outDir, "leads.csv");
  writeJson(jsonPath, filtered);
  fs.writeFileSync(csvPath, toRows(filtered), "utf8");
  // Mirror under run export/
  writeJson(path.join(exportDir, "leads.json"), filtered);
  fs.writeFileSync(path.join(exportDir, "leads.csv"), toRows(filtered), "utf8");

  ensureRunMeta(runDir, runId, config, "lead-export");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    dryRun,
    count: filtered.length,
    jsonPath,
    csvPath,
  });

  console.log(`Exported ${filtered.length} leads (minScore=${minScore})`);
  console.log(`  JSON → ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  CSV  → ${path.relative(process.cwd(), csvPath)}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (filtered.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: "Export wrote 0 leads.",
    };
  }
  return { exitCode: 0, message: `Exported ${filtered.length} leads` };
}
