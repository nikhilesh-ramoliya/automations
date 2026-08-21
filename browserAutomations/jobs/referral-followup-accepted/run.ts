import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import { hasLinkedInAuth, withLinkedInPage } from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import { messageAcceptedConnection } from "../../lib/leads/linkedin-message.js";
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
  readJson,
  resolveRunDir,
  writeJson,
} from "../../lib/referral/io.js";
import {
  ARTIFACTS,
  type ReferralFollowupResult,
  type ReferralSendResult,
  type ReferralTarget,
} from "../../lib/referral/types.js";
import {
  SafetyLimitError,
  humanDelay,
  remainingCap,
} from "../../lib/linkedin-safety.js";

const PENDING_CONNECT_DETAILS = new Set([
  "connected",
  "note_sent",
  "pending",
  "dry_run",
]);

function alreadyMessagedLive(
  prior: ReferralFollowupResult[],
  targetId: string,
): boolean {
  return prior.some(
    (r) => r.targetId === targetId && r.status === "messaged" && !r.dryRun,
  );
}

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "referral-followup-accepted",
    });
  }

  const dryRun = isReferralDryRun();
  const max = envInt("REFERRAL_FOLLOWUP_MAX", 10);
  const onlyAccepted = envBool("REFERRAL_FOLLOWUP_ONLY_ACCEPTED", false);
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("referral-followup-accepted");
  const writer = createJsonlLogger(logPath);

  const sent =
    readJson<ReferralSendResult[]>(artifactPath(runDir, ARTIFACTS.sent)) ?? [];
  const priorFollowup =
    readJson<ReferralFollowupResult[]>(
      artifactPath(runDir, ARTIFACTS.followup),
    ) ?? [];
  const targets = loadTargets(runDir);
  const targetById = new Map<string, ReferralTarget>(
    targets.map((t) => [t.id, t]),
  );

  const candidates = sent.filter(
    (r) =>
      r.action === "linkedin_connect" &&
      r.ok &&
      r.detail != null &&
      PENDING_CONNECT_DETAILS.has(r.detail) &&
      Boolean(r.linkedinUrl) &&
      !alreadyMessagedLive(priorFollowup, r.targetId),
  );

  const byTarget = new Map<string, ReferralSendResult>();
  for (const row of candidates) {
    byTarget.set(row.targetId, row);
  }
  const unique = [...byTarget.values()];

  if (unique.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.followup), priorFollowup);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message:
        "No pending connects to follow up — run referral-send-connect first, or all already messaged.",
    };
  }

  const msgLeft = remainingCap("message");
  const batchCap = Math.min(max, unique.length, Math.max(0, msgLeft));
  if (batchCap === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.followup), priorFollowup);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: `Message daily cap reached (remaining=${msgLeft}).`,
    };
  }

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "LinkedIn session missing. Run `npm run auth:linkedin`.",
    };
  }

  const batch = unique.slice(0, batchCap);
  const results: ReferralFollowupResult[] = [...priorFollowup];
  const now = new Date().toISOString();
  let hitCap = false;

  console.log(
    `\nReferral follow-up: up to ${batch.length} (run ${runId}, dryRun=${dryRun})\n`,
  );

  try {
    await withLinkedInPage(
      async (page) => {
        for (const row of batch) {
          const target = targetById.get(row.targetId);
          const message =
            target?.referralMessage ??
            `Hi there, I'm a Full Stack / MERN / React developer. I saw an opening at ${row.companyName} and would really appreciate a referral if possible. Thanks!`;
          const url = row.linkedinUrl;
          if (!url) {
            results.push({
              targetId: row.targetId,
              personName: row.personName,
              companyName: row.companyName,
              jobTitle: row.jobTitle,
              dryRun,
              ok: false,
              status: "skipped",
              detail: "no_linkedin_url",
              followedUpAt: now,
            });
            continue;
          }

          try {
            const res = await messageAcceptedConnection(page, {
              profileUrl: url,
              message,
              dryRun,
              onlyAccepted,
            });
            const out: ReferralFollowupResult = res.ok
              ? {
                  targetId: row.targetId,
                  personName: row.personName,
                  companyName: row.companyName,
                  jobTitle: row.jobTitle,
                  linkedinUrl: url,
                  status: res.status,
                  detail: res.detail,
                  messagePreview: res.messagePreview,
                  dryRun,
                  ok: true,
                  followedUpAt: now,
                }
              : {
                  targetId: row.targetId,
                  personName: row.personName,
                  companyName: row.companyName,
                  jobTitle: row.jobTitle,
                  linkedinUrl: url,
                  status: "error",
                  detail: res.error,
                  dryRun,
                  ok: false,
                  followedUpAt: now,
                };
            results.push(out);
            writer.log({ ts: now, type: "followup", ...out });
          } catch (err) {
            if (err instanceof SafetyLimitError) {
              hitCap = true;
              console.warn(`Message/safety cap: ${err.message}`);
              results.push({
                targetId: row.targetId,
                personName: row.personName,
                companyName: row.companyName,
                jobTitle: row.jobTitle,
                linkedinUrl: url,
                status: "error",
                detail: err.message,
                dryRun,
                ok: false,
                followedUpAt: now,
              });
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            results.push({
              targetId: row.targetId,
              personName: row.personName,
              companyName: row.companyName,
              jobTitle: row.jobTitle,
              linkedinUrl: url,
              status: "error",
              detail: msg,
              dryRun,
              ok: false,
              followedUpAt: now,
            });
          }
          await humanDelay("between_companies");
        }
      },
      { jobId: "referral-followup-accepted" },
    );
  } catch (err) {
    if (err instanceof SafetyLimitError) {
      hitCap = true;
      console.warn(`Safety limit: ${err.message}`);
    } else {
      throw err;
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.followup), results);
  ensureRunMeta(runDir, runId, config, "referral-followup-accepted");

  const thisRun = results.slice(priorFollowup.length);
  const messagedN = thisRun.filter((r) => r.status === "messaged").length;
  const pendingN = thisRun.filter((r) => r.status === "pending").length;
  const skippedN = thisRun.filter((r) => r.status === "skipped").length;
  const errorN = thisRun.filter((r) => r.status === "error").length;

  console.log(
    `\nFollow-up: messaged=${messagedN}, pending=${pendingN}, skipped=${skippedN}, error=${errorN}`,
  );
  console.log(`→ data/referral/${runId}/${ARTIFACTS.followup}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  return {
    exitCode: 0,
    softSuccess: hitCap,
    message: `Processed ${thisRun.length}: messaged=${messagedN} pending=${pendingN}`,
  };
}
