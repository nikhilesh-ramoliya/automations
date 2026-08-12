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
  resolveCompaniesArtifactPath,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";
import {
  isCompanySuppressed,
  isPersonSuppressed,
  loadSuppressLists,
} from "../../lib/leads/suppress.js";
import { ARTIFACTS } from "../../lib/leads/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isLeadDryRun();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-suppress");
  const writer = createJsonlLogger(logPath);
  const lists = loadSuppressLists();

  const companies = loadCompanies(runDir, "best");
  const people = loadPeople(runDir);

  let coSuppressed = 0;
  let peSuppressed = 0;

  const companiesOut = companies.map((c) => {
    const reason = isCompanySuppressed(
      c.name,
      c.linkedinUrl,
      c.websiteUrl,
      lists,
    );
    if (reason) {
      coSuppressed += 1;
      writer.log({
        ts: new Date().toISOString(),
        type: "suppress_company",
        name: c.name,
        reason,
      });
      return { ...c, suppressed: true, suppressReason: reason };
    }
    return { ...c, suppressed: false, suppressReason: undefined };
  });

  const peopleOut = people.map((p) => {
    const reason = isPersonSuppressed(p.name, p.linkedinUrl, lists);
    if (reason) {
      peSuppressed += 1;
      writer.log({
        ts: new Date().toISOString(),
        type: "suppress_person",
        name: p.name,
        reason,
      });
      return { ...p, suppressed: true, suppressReason: reason };
    }
    return { ...p, suppressed: false, suppressReason: undefined };
  });

  const basePath = artifactPath(runDir, ARTIFACTS.companies);
  const companiesFile = resolveCompaniesArtifactPath(runDir);
  writeJson(companiesFile, companiesOut);
  // Never clobber discover base with an empty advanced artifact
  if (companiesFile === basePath || companiesOut.length > 0) {
    writeJson(basePath, companiesOut);
  }
  writeJson(artifactPath(runDir, ARTIFACTS.people), peopleOut);

  ensureRunMeta(runDir, runId, config, "lead-suppress");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    dryRun,
    companiesSuppressed: coSuppressed,
    peopleSuppressed: peSuppressed,
  });
  console.log(
    `Suppress run ${runId}: companies ${coSuppressed}, people ${peSuppressed}`,
  );
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();
  return {
    exitCode: 0,
    message: `Suppressed ${coSuppressed} companies, ${peSuppressed} people`,
  };
}
