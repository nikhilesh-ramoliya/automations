import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import { hasLinkedInAuth, withLinkedInPage } from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import {
  envBool,
  envInt,
  isLeadDryRun,
  snapshotConfigFromEnv,
} from "../../lib/leads/env.js";
import {
  artifactPath,
  ensureRunMeta,
  loadLeads,
  loadLeadsOutreach,
  readJson,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";
import { messageAcceptedConnection } from "../../lib/leads/linkedin-message.js";
import { draftFollowupMessage } from "../../lib/leads/outreach.js";
import {
  ARTIFACTS,
  type FollowupResult,
  type LeadWithOutreach,
  type OutreachSendResult,
  type QualifiedLead,
} from "../../lib/leads/types.js";
import {
  SafetyLimitError,
  humanDelay,
  remainingCap,
} from "../../lib/linkedin-safety.js";

/** Sent-connect details that are candidates for accept follow-up. */
const PENDING_CONNECT_DETAILS = new Set([
  "connected",
  "note_sent",
  "pending",
]);

function alreadyMessagedLive(
  prior: FollowupResult[],
  leadId: string,
): boolean {
  return prior.some(
    (r) => r.leadId === leadId && r.status === "messaged" && !r.dryRun,
  );
}

function resolveContext(
  leadId: string,
  outreach: LeadWithOutreach[],
  leads: QualifiedLead[],
): {
  personName?: string;
  companyName: string;
  serviceLabel: string;
  priorLinkedInDraft?: string;
  linkedinUrl?: string;
} {
  const withOut = outreach.find((l) => l.id === leadId);
  if (withOut) {
    const li = withOut.outreach.find((o) => o.channel === "linkedin");
    return {
      personName: withOut.personName ?? withOut.person?.name,
      companyName: withOut.companyName,
      serviceLabel: withOut.recommendedServiceLabel,
      priorLinkedInDraft: li?.body,
      linkedinUrl: withOut.person?.linkedinUrl,
    };
  }
  const lead = leads.find((l) => l.id === leadId);
  if (lead) {
    return {
      personName: lead.personName ?? lead.person?.name,
      companyName: lead.companyName,
      serviceLabel: lead.recommendedServiceLabel,
      linkedinUrl: lead.person?.linkedinUrl,
    };
  }
  return { companyName: "your team", serviceLabel: "custom software" };
}

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "lead-followup-accepted",
    });
  }

  const dryRun = isLeadDryRun();
  const max = envInt("LEAD_FOLLOWUP_MAX", 10);
  const onlyAccepted = envBool("LEAD_FOLLOWUP_ONLY_ACCEPTED", false);
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-followup-accepted");
  const writer = createJsonlLogger(logPath);

  const sentPath = artifactPath(runDir, ARTIFACTS.leadsSent);
  const sent = readJson<OutreachSendResult[]>(sentPath) ?? [];
  const priorFollowup =
    readJson<FollowupResult[]>(
      artifactPath(runDir, ARTIFACTS.leadsFollowup),
    ) ?? [];

  const candidates = sent.filter(
    (r) =>
      r.action === "linkedin_connect" &&
      r.ok &&
      r.detail != null &&
      PENDING_CONNECT_DETAILS.has(r.detail) &&
      Boolean(r.linkedinUrl) &&
      !alreadyMessagedLive(priorFollowup, r.leadId),
  );

  // Dedupe by leadId (keep latest sent row)
  const byLead = new Map<string, OutreachSendResult>();
  for (const row of candidates) {
    byLead.set(row.leadId, row);
  }
  const unique = [...byLead.values()];

  if (unique.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.leadsFollowup), priorFollowup);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message:
        "No pending LinkedIn connects to follow up — run lead-send-outreach first, or all already messaged.",
    };
  }

  const msgLeft = remainingCap("message");
  const batchCap = Math.min(max, unique.length, Math.max(0, msgLeft));
  if (batchCap === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.leadsFollowup), priorFollowup);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: `Message daily cap reached (remaining=${msgLeft}).`,
    };
  }

  const batch = unique.slice(0, batchCap);
  const outreach = loadLeadsOutreach(runDir);
  const leads = loadLeads(runDir);
  const results: FollowupResult[] = [...priorFollowup];
  const now = new Date().toISOString();

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "LinkedIn session missing. Run `npm run auth:linkedin`.",
    };
  }

  console.log(
    `\nFollow-up accepted connects: up to ${batch.length} (run ${runId}, dryRun=${dryRun}, onlyAccepted=${onlyAccepted})\n`,
  );

  let hitCap = false;
  try {
    await withLinkedInPage(
      async (page) => {
        for (const row of batch) {
          const ctx = resolveContext(row.leadId, outreach, leads);
          const url = row.linkedinUrl ?? ctx.linkedinUrl;
          if (!url) {
            const skip: FollowupResult = {
              leadId: row.leadId,
              companyName: row.companyName,
              personName: row.personName,
              dryRun,
              ok: false,
              status: "skipped",
              detail: "no_linkedin_url",
              followedUpAt: now,
            };
            results.push(skip);
            writer.log({ ts: now, type: "followup", ...skip });
            continue;
          }

          const drafted = draftFollowupMessage({
            personName: row.personName ?? ctx.personName,
            companyName: row.companyName || ctx.companyName,
            serviceLabel: ctx.serviceLabel,
            priorLinkedInDraft: ctx.priorLinkedInDraft,
          });

          try {
            const res = await messageAcceptedConnection(page, {
              profileUrl: url,
              message: drafted.body,
              dryRun,
              onlyAccepted,
            });
            const out: FollowupResult = res.ok
              ? {
                  leadId: row.leadId,
                  companyName: row.companyName,
                  personName: row.personName ?? ctx.personName,
                  linkedinUrl: url,
                  status: res.status,
                  detail: res.detail,
                  messagePreview: res.messagePreview,
                  dryRun,
                  ok: true,
                  followedUpAt: now,
                }
              : {
                  leadId: row.leadId,
                  companyName: row.companyName,
                  personName: row.personName ?? ctx.personName,
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
              console.warn(`Message/safety cap hit: ${err.message}`);
              hitCap = true;
              results.push({
                leadId: row.leadId,
                companyName: row.companyName,
                personName: row.personName ?? ctx.personName,
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
              leadId: row.leadId,
              companyName: row.companyName,
              personName: row.personName ?? ctx.personName,
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
      { jobId: "lead-followup-accepted" },
    );
  } catch (err) {
    if (err instanceof SafetyLimitError) {
      hitCap = true;
      console.warn(`Safety limit: ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`LinkedIn session failed: ${msg}`);
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.leadsFollowup), results);
  ensureRunMeta(runDir, runId, config, "lead-followup-accepted");

  const thisRun = results.slice(priorFollowup.length);
  const pendingN = thisRun.filter((r) => r.status === "pending").length;
  const messagedN = thisRun.filter((r) => r.status === "messaged").length;
  const skippedN = thisRun.filter((r) => r.status === "skipped").length;
  const errorN = thisRun.filter((r) => r.status === "error").length;

  console.log(
    `\nFollow-up summary: messaged=${messagedN}, pending=${pendingN}, skipped=${skippedN}, error=${errorN} (dryRun=${dryRun})`,
  );
  console.log(`→ data/leads/${runId}/${ARTIFACTS.leadsFollowup}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (hitCap) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: `Processed ${thisRun.length} (cap hit). messaged=${messagedN} pending=${pendingN}`,
    };
  }

  return {
    exitCode: 0,
    message: `Processed ${thisRun.length}: messaged=${messagedN} pending=${pendingN} skipped=${skippedN} error=${errorN}`,
  };
}
