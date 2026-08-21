import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import { hasLinkedInAuth, withLinkedInPage } from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import { connectWithOptionalNote } from "../../lib/leads/linkedin-connect.js";
import {
  envBool,
  envInt,
  isReferralDryRun,
  snapshotConfigFromEnv,
} from "../../lib/referral/env.js";
import {
  artifactPath,
  ensureRunMeta,
  loadTargets,
  resolveRunDir,
  writeJson,
} from "../../lib/referral/io.js";
import {
  ARTIFACTS,
  type ReferralSendResult,
} from "../../lib/referral/types.js";
import {
  SafetyLimitError,
  humanDelay,
  remainingCap,
} from "../../lib/linkedin-safety.js";

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "referral-send-connect",
    });
  }

  const dryRun = isReferralDryRun();
  const addNote = envBool("REFERRAL_SEND_ADD_NOTE", true);
  const max = envInt("REFERRAL_SEND_MAX", 10);
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("referral-send-connect");
  const writer = createJsonlLogger(logPath);

  const targets = loadTargets(runDir);
  if (targets.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.sent), []);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No targets — run referral-draft first.",
    };
  }

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "LinkedIn session missing. Run `npm run auth:linkedin`.",
    };
  }

  const connectLeft = remainingCap("connect");
  const batchCap = Math.min(max, targets.length, Math.max(0, connectLeft));
  if (batchCap === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.sent), []);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: `Connect daily cap reached (remaining=${connectLeft}).`,
    };
  }

  const batch = targets.slice(0, batchCap);
  const results: ReferralSendResult[] = [];
  const now = new Date().toISOString();
  let hitCap = false;

  console.log(
    `\nReferral connect: up to ${batch.length} (run ${runId}, dryRun=${dryRun}, note=${addNote})\n`,
  );

  try {
    await withLinkedInPage(
      async (page) => {
        for (const t of batch) {
          try {
            const res = await connectWithOptionalNote(page, {
              profileUrl: t.personLinkedInUrl,
              note: addNote ? t.connectNote : undefined,
              addNote,
              dryRun,
            });
            const row: ReferralSendResult = res.ok
              ? {
                  targetId: t.id,
                  personName: t.personName,
                  companyName: t.companyName,
                  jobTitle: t.jobTitle,
                  linkedinUrl: t.personLinkedInUrl,
                  action: "linkedin_connect",
                  dryRun,
                  ok: true,
                  detail: res.mode,
                  sentAt: now,
                }
              : {
                  targetId: t.id,
                  personName: t.personName,
                  companyName: t.companyName,
                  jobTitle: t.jobTitle,
                  linkedinUrl: t.personLinkedInUrl,
                  action: "linkedin_connect",
                  dryRun,
                  ok: false,
                  detail: res.error,
                  sentAt: now,
                };
            results.push(row);
            writer.log({ ts: now, type: "send", ...row });
          } catch (err) {
            if (err instanceof SafetyLimitError) {
              hitCap = true;
              console.warn(`Connect/safety cap: ${err.message}`);
              results.push({
                targetId: t.id,
                personName: t.personName,
                companyName: t.companyName,
                jobTitle: t.jobTitle,
                linkedinUrl: t.personLinkedInUrl,
                action: "skip",
                dryRun,
                ok: false,
                detail: err.message,
                sentAt: now,
              });
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            results.push({
              targetId: t.id,
              personName: t.personName,
              companyName: t.companyName,
              jobTitle: t.jobTitle,
              linkedinUrl: t.personLinkedInUrl,
              action: "linkedin_connect",
              dryRun,
              ok: false,
              detail: msg,
              sentAt: now,
            });
          }
          await humanDelay("between_companies");
        }
      },
      { jobId: "referral-send-connect" },
    );
  } catch (err) {
    if (err instanceof SafetyLimitError) {
      hitCap = true;
      console.warn(`Safety limit: ${err.message}`);
    } else {
      throw err;
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.sent), results);
  ensureRunMeta(runDir, runId, config, "referral-send-connect");

  const okN = results.filter((r) => r.ok).length;
  console.log(
    `\nConnect summary: ok=${okN}/${results.length} (dryRun=${dryRun})`,
  );
  console.log(`→ data/referral/${runId}/${ARTIFACTS.sent}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  return {
    exitCode: 0,
    softSuccess: hitCap || okN === 0,
    message: `Connect attempts ${results.length}: ok=${okN}`,
  };
}
