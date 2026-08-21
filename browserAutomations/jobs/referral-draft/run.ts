import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  isReferralDryRun,
  snapshotConfigFromEnv,
} from "../../lib/referral/env.js";
import {
  artifactPath,
  ensureRunMeta,
  loadJobs,
  loadPeople,
  normalizeCompanyName,
  normalizeLinkedInUrl,
  resolveRunDir,
  slugId,
  writeJson,
} from "../../lib/referral/io.js";
import {
  draftConnectNote,
  draftReferralMessage,
} from "../../lib/referral/outreach.js";
import {
  ARTIFACTS,
  type JobPosting,
  type ReferralPerson,
  type ReferralTarget,
} from "../../lib/referral/types.js";

function jobsForPerson(
  person: ReferralPerson,
  jobs: JobPosting[],
): JobPosting[] {
  const byCompanyUrl = person.companyLinkedInUrl
    ? normalizeLinkedInUrl(person.companyLinkedInUrl)
    : undefined;
  const companyNorm = normalizeCompanyName(person.companyName);

  return jobs.filter((j) => {
    const jUrl = normalizeLinkedInUrl(j.companyLinkedInUrl);
    if (byCompanyUrl && jUrl && byCompanyUrl === jUrl) return true;
    return normalizeCompanyName(j.companyName) === companyNorm;
  });
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isReferralDryRun();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("referral-draft");
  const writer = createJsonlLogger(logPath);

  const jobs = loadJobs(runDir);
  const people = loadPeople(runDir);

  if (people.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.targets), []);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No people — run referral-find-people first.",
    };
  }

  const now = new Date().toISOString();
  const targets: ReferralTarget[] = [];
  const seenPair = new Set<string>();

  for (const person of people) {
    const matchedJobs = jobsForPerson(person, jobs);
    // One target per person: prefer first matching job (or a synthetic stub)
    const job =
      matchedJobs[0] ??
      ({
        id: slugId("job", person.companyName),
        title: "open role",
        companyName: person.companyName,
        jobUrl: "",
        geo: config.geos[0] ?? "India",
        roleQuery: config.roles[0] ?? "Full Stack Developer",
        matchedKeywords: [],
        discoveredAt: now,
      } satisfies JobPosting);

    const pairKey = `${person.linkedinUrl.toLowerCase()}::${job.id}`;
    if (seenPair.has(pairKey)) continue;
    seenPair.add(pairKey);

    const geo = job.geo || matchedJobs[0]?.geo || config.geos[0] || "India";
    const connectNote = draftConnectNote({
      personName: person.name,
      geo,
    });
    const referralMessage = draftReferralMessage({
      personName: person.name,
      companyName: person.companyName || job.companyName,
      jobTitle: job.title,
    });

    const target: ReferralTarget = {
      id: slugId("target", `${person.name}-${job.id}`),
      personId: person.id,
      jobId: job.id,
      personName: person.name,
      personTitle: person.title,
      personLinkedInUrl: person.linkedinUrl,
      kind: person.kind,
      companyName: person.companyName || job.companyName,
      jobTitle: job.title,
      jobUrl: job.jobUrl,
      geo,
      connectNote,
      referralMessage,
      draftedAt: now,
    };
    targets.push(target);
    writer.log({
      ts: now,
      type: "drafted",
      targetId: target.id,
      person: target.personName,
      company: target.companyName,
      kind: target.kind,
    });
  }

  writeJson(artifactPath(runDir, ARTIFACTS.targets), targets);
  ensureRunMeta(runDir, runId, config, "referral-draft");

  console.log(
    `Drafted ${targets.length} referral targets (dryRun=${dryRun}, never sent)`,
  );
  console.log(`→ data/referral/${runId}/${ARTIFACTS.targets}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  return { exitCode: 0, message: `Drafted ${targets.length} targets` };
}
