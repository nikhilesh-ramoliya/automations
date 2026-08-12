import "dotenv/config";
import dns from "node:dns/promises";
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
  loadCompanies,
  loadPeople,
  resolveCompaniesArtifactPath,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";
import {
  ARTIFACTS,
  type ContactVerification,
  type CompanyRecord,
  type PersonRecord,
} from "../../lib/leads/types.js";

function linkedinUrlOk(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.hostname.includes("linkedin.com") &&
      (/\/company\/[^/]+/i.test(u.pathname) || /\/in\/[^/]+/i.test(u.pathname))
    );
  } catch {
    return false;
  }
}

async function websiteResponds(url: string | undefined): Promise<{
  ok: boolean;
  note: string;
}> {
  if (!url) return { ok: false, note: "no_website" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; LanatusLeadBot/1.0; +local-verify)",
      },
    });
    clearTimeout(t);
    const ok = res.status >= 200 && res.status < 400;
    return { ok, note: `http_${res.status}` };
  } catch (err) {
    return {
      ok: false,
      note: err instanceof Error ? err.message.slice(0, 120) : "fetch_fail",
    };
  }
}

async function emailMxOk(
  email: string | undefined,
): Promise<boolean | null> {
  if (!email || !email.includes("@")) return null;
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return null;
  try {
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
  // Provider-ready hook: paid email verification API can replace MX later.
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isLeadDryRun();
  const max = envInt("LEAD_MAX_COMPANIES", 10);
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-verify-contact");
  const writer = createJsonlLogger(logPath);

  let companies = loadCompanies(runDir, "best").slice(0, max);
  let people = loadPeople(runDir);

  const companyIds = new Set(companies.map((c) => c.id));
  people = people.filter((p) => companyIds.has(p.companyId) || companies.length === 0);

  const companiesOut: CompanyRecord[] = [];
  for (const c of companies) {
    const web = await websiteResponds(c.websiteUrl);
    const liOk = linkedinUrlOk(c.linkedinUrl);
    const verification: ContactVerification = {
      websiteOk: c.websiteUrl ? web.ok : undefined,
      linkedinOk: c.linkedinUrl ? liOk : undefined,
      emailMxOk: null,
      notes: [
        c.websiteUrl ? web.note : "no_website",
        c.linkedinUrl
          ? liOk
            ? "linkedin_url_shape_ok"
            : "linkedin_url_shape_bad"
          : "no_linkedin",
      ],
      checkedAt: new Date().toISOString(),
    };
    companiesOut.push({ ...c, verification });
    writer.log({
      ts: new Date().toISOString(),
      type: "verify_company",
      name: c.name,
      websiteOk: verification.websiteOk,
      linkedinOk: verification.linkedinOk,
    });
  }

  const peopleOut: PersonRecord[] = [];
  for (const p of people) {
    const liOk = linkedinUrlOk(p.linkedinUrl);
    const mx = await emailMxOk(p.email);
    const verification: ContactVerification = {
      linkedinOk: p.linkedinUrl ? liOk : undefined,
      emailMxOk: mx,
      notes: [
        p.linkedinUrl
          ? liOk
            ? "linkedin_url_shape_ok"
            : "linkedin_url_shape_bad"
          : "no_linkedin",
        mx === null
          ? "email_not_checked"
          : mx
            ? "email_mx_ok"
            : "email_mx_fail",
        // Stub: email provider verification not configured
        "email_provider:stub",
      ],
      checkedAt: new Date().toISOString(),
    };
    peopleOut.push({ ...p, verification });
    writer.log({
      ts: new Date().toISOString(),
      type: "verify_person",
      name: p.name,
      linkedinOk: verification.linkedinOk,
      emailMxOk: mx,
    });
  }

  const companiesFile = resolveCompaniesArtifactPath(runDir);
  writeJson(companiesFile, companiesOut);
  writeJson(artifactPath(runDir, ARTIFACTS.people), peopleOut);
  ensureRunMeta(runDir, runId, config, "lead-verify-contact");

  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    dryRun,
    companies: companiesOut.length,
    people: peopleOut.length,
  });
  console.log(
    `Verified ${companiesOut.length} companies, ${peopleOut.length} people (run ${runId})`,
  );
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();
  return { exitCode: 0 };
}
