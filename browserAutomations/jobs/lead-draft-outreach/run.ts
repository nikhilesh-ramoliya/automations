import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  envInt,
  isLeadDryRun,
  snapshotConfigFromEnv,
} from "../../lib/leads/env.js";
import {
  artifactPath,
  ensureRunMeta,
  loadLeads,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";
import { draftOutreach } from "../../lib/leads/outreach.js";
import {
  ARTIFACTS,
  type LeadWithOutreach,
  type OutreachDraft,
} from "../../lib/leads/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isLeadDryRun();
  const minScore = envInt("LEAD_MIN_SCORE", 60);
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-draft-outreach");
  const writer = createJsonlLogger(logPath);

  const leads = loadLeads(runDir).filter((l) => l.score >= minScore);
  if (leads.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.leadsOutreach), []);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No qualified leads to draft.",
    };
  }

  const now = new Date().toISOString();
  const out: LeadWithOutreach[] = [];

  for (const lead of leads) {
    const drafts = draftOutreach({
      company: lead.company,
      person: lead.person,
      serviceId: lead.recommendedService,
      serviceLabel: lead.recommendedServiceLabel,
    });
    const outreach: OutreachDraft[] = drafts.map((d) => ({
      leadId: lead.id,
      channel: d.channel,
      subject: d.subject,
      body: d.body,
      personalizedFrom: d.personalizedFrom,
      draftedAt: now,
    }));
    out.push({ ...lead, outreach });
    writer.log({
      ts: new Date().toISOString(),
      type: "drafted",
      leadId: lead.id,
      company: lead.companyName,
      channels: outreach.map((o) => o.channel),
    });
  }

  writeJson(artifactPath(runDir, ARTIFACTS.leadsOutreach), out);
  ensureRunMeta(runDir, runId, config, "lead-draft-outreach");

  console.log(`Drafted outreach for ${out.length} leads (dryRun=${dryRun}, never sent)`);
  console.log(`→ data/leads/${runId}/${ARTIFACTS.leadsOutreach}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();
  return { exitCode: 0, message: `Drafted ${out.length} outreach packs` };
}
