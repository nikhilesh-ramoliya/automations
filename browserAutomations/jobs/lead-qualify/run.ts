import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  leadMinCompanyScore,
  passesLeadGate,
} from "../../lib/leads/company-quality.js";
import {
  envInt,
  isLeadDryRun,
  leadIndustries,
  leadKeywords,
  snapshotConfigFromEnv,
} from "../../lib/leads/env.js";
import {
  artifactPath,
  ensureRunMeta,
  loadCompanies,
  loadPeople,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";
import { scoreLead, toQualifiedLead } from "../../lib/leads/scoring.js";
import {
  ARTIFACTS,
  type CompanyRecord,
  type QualifiedLead,
} from "../../lib/leads/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isLeadDryRun();
  const minScore = envInt("LEAD_MIN_SCORE", 60);
  const minCompanyScore = leadMinCompanyScore();
  const keywords = leadKeywords();
  const industries = leadIndustries();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-qualify");
  const writer = createJsonlLogger(logPath);

  const loaded = loadCompanies(runDir, "best").filter((c) => !c.suppressed);
  const companies: CompanyRecord[] = [];
  for (const company of loaded) {
    const gate = passesLeadGate(company, minCompanyScore, {
      keywords,
      industries,
    });
    if (!gate.pass) {
      writer.log({
        ts: new Date().toISOString(),
        type: "company_rejected",
        name: company.name,
        score: gate.score,
        reasons: gate.reasons,
        stage: "qualify",
      });
      console.log(
        `  ✗ skip company ${company.name} (icp=${gate.score}: ${gate.reasons.join(", ")})`,
      );
      continue;
    }
    companies.push(company);
  }

  const people = loadPeople(runDir).filter((p) => !p.suppressed);
  const peopleByCompany = new Map<string, typeof people>();
  for (const p of people) {
    const list = peopleByCompany.get(p.companyId) ?? [];
    list.push(p);
    peopleByCompany.set(p.companyId, list);
  }

  const allScored: QualifiedLead[] = [];
  const qualified: QualifiedLead[] = [];

  for (const company of companies) {
    const contacts = peopleByCompany.get(company.id) ?? [];
    if (contacts.length === 0) {
      const scored = scoreLead({ company, keywords, industries });
      const lead = toQualifiedLead(company, undefined, scored);
      allScored.push(lead);
      writer.log({
        ts: new Date().toISOString(),
        type: "scored",
        company: company.name,
        score: scored.score,
        service: scored.recommendedService,
      });
      if (scored.score >= minScore) qualified.push(lead);
      continue;
    }
    for (const person of contacts) {
      const scored = scoreLead({ company, person, keywords, industries });
      const lead = toQualifiedLead(company, person, scored);
      allScored.push(lead);
      writer.log({
        ts: new Date().toISOString(),
        type: "scored",
        company: company.name,
        person: person.name,
        score: scored.score,
        service: scored.recommendedService,
      });
      if (scored.score >= minScore) qualified.push(lead);
    }
  }

  qualified.sort((a, b) => b.score - a.score);
  writeJson(artifactPath(runDir, ARTIFACTS.leads), qualified);
  // Keep a debug-friendly full score dump next to it
  writeJson(path.join(runDir, "leads.scored-all.json"), allScored);

  ensureRunMeta(runDir, runId, config, "lead-qualify");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    dryRun,
    companiesConsidered: companies.length,
    companiesSkipped: loaded.length - companies.length,
    scored: allScored.length,
    qualified: qualified.length,
    minScore,
    minCompanyScore,
  });

  console.log(
    `Qualify run ${runId}: ${qualified.length}/${allScored.length} ≥ ${minScore} (icp≥${minCompanyScore}, ${companies.length} cos)`,
  );
  for (const l of qualified.slice(0, 12)) {
    console.log(
      `  • ${l.companyName}${l.personName ? ` / ${l.personName}` : ""} score=${l.score} → ${l.recommendedServiceLabel}`,
    );
  }
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (qualified.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: `No leads scored ≥ ${minScore}`,
    };
  }
  return { exitCode: 0, message: `Qualified ${qualified.length} leads` };
}
