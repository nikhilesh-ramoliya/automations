import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import { hasGoogleAuth } from "../../lib/auth-google.js";
import { hasLinkedInAuth, withLinkedInPage } from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import { envBool } from "../../lib/leads/env.js";
import {
  envInt,
  isLeadDryRun,
  snapshotConfigFromEnv,
} from "../../lib/leads/env.js";
import {
  hasGoogleSessionFiles,
  sendGmailCompose,
  withGmailPage,
} from "../../lib/leads/gmail-send.js";
import {
  artifactPath,
  ensureRunMeta,
  readJson,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";
import { connectWithOptionalNote } from "../../lib/leads/linkedin-connect.js";
import {
  ARTIFACTS,
  type LeadWithOutreach,
  type OutreachSendResult,
} from "../../lib/leads/types.js";
import {
  SafetyLimitError,
  humanDelay,
} from "../../lib/linkedin-safety.js";

function pickEmail(lead: LeadWithOutreach): string | undefined {
  const fromPerson = lead.person?.email?.trim();
  if (fromPerson && fromPerson.includes("@")) return fromPerson;
  return undefined;
}

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "lead-send-outreach",
    });
  }

  const dryRun = isLeadDryRun();
  const addNote = envBool("LEAD_SEND_ADD_NOTE", true);
  /** Email is off by default — use lead-followup-accepted for post-accept DMs. */
  const sendEmail = envBool("LEAD_SEND_EMAIL", false);
  const max = envInt("LEAD_SEND_MAX", 10);
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-send-outreach");
  const writer = createJsonlLogger(logPath);

  const outreachPath = artifactPath(runDir, ARTIFACTS.leadsOutreach);
  const leads = readJson<LeadWithOutreach[]>(outreachPath) ?? [];
  if (leads.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.leadsSent), []);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No outreach drafts — run lead-draft-outreach first.",
    };
  }

  const batch = leads.slice(0, max);
  const results: OutreachSendResult[] = [];
  const now = new Date().toISOString();

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message:
        "LinkedIn session missing. Run `npm run auth:linkedin`.",
    };
  }

  console.log(
    `\nSend outreach for up to ${batch.length} leads (run ${runId}, dryRun=${dryRun})\n` +
      `  mode → LinkedIn connect${addNote ? " + note" : ""}` +
      (sendEmail ? " (+ email if person.email)" : " (email skipped)") +
      `\n`,
  );

  // --- Optional email (off by default) ---
  const emailLeads = sendEmail
    ? batch.filter((l) => pickEmail(l))
    : [];
  if (emailLeads.length > 0) {
    if (!hasGoogleAuth() && !hasGoogleSessionFiles()) {
      await writer.close();
      return {
        exitCode: 1,
        message:
          "LEAD_SEND_EMAIL=true but Google session missing. Run `npm run auth:google`.",
      };
    }
    try {
      await withGmailPage(async (page) => {
        for (const lead of emailLeads) {
          const to = pickEmail(lead)!;
          const draft = lead.outreach.find((o) => o.channel === "email");
          const subject = draft?.subject ?? `${lead.companyName} — Lanatus`;
          const body = draft?.body ?? "";
          try {
            const res = await sendGmailCompose(page, {
              to,
              subject,
              body,
              dryRun,
            });
            const row: OutreachSendResult = {
              leadId: lead.id,
              companyName: lead.companyName,
              personName: lead.personName,
              action: "email",
              email: to,
              dryRun,
              ok: res.ok,
              detail: res.ok ? res.mode : res.error,
              sentAt: now,
            };
            results.push(row);
            writer.log({ ts: now, type: "send", ...row });
            await humanDelay("between_companies");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({
              leadId: lead.id,
              companyName: lead.companyName,
              personName: lead.personName,
              action: "email",
              email: to,
              dryRun,
              ok: false,
              detail: msg,
              sentAt: now,
            });
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Gmail session failed: ${msg}`);
    }
  }

  // --- LinkedIn connect (default path) ---
  const emailedIds = new Set(emailLeads.map((l) => l.id));
  const connectLeads = batch.filter(
    (l) => !emailedIds.has(l.id) && Boolean(l.person?.linkedinUrl),
  );
  const skipLeads = batch.filter(
    (l) => !emailedIds.has(l.id) && !l.person?.linkedinUrl,
  );

  for (const lead of skipLeads) {
    const row: OutreachSendResult = {
      leadId: lead.id,
      companyName: lead.companyName,
      personName: lead.personName,
      action: "skip",
      reason: "no_linkedin_url",
      dryRun,
      ok: false,
      detail: "Need person.linkedinUrl for connect",
      sentAt: now,
    };
    results.push(row);
    writer.log({ ts: now, type: "skip", ...row });
  }

  if (connectLeads.length > 0) {
    try {
      await withLinkedInPage(
        async (page) => {
          for (const lead of connectLeads) {
            const url = lead.person!.linkedinUrl!;
            const draft = lead.outreach.find((o) => o.channel === "linkedin");
            try {
              const res = await connectWithOptionalNote(page, {
                profileUrl: url,
                note: draft?.body,
                dryRun,
                addNote,
              });
              const row: OutreachSendResult = {
                leadId: lead.id,
                companyName: lead.companyName,
                personName: lead.personName,
                action: "linkedin_connect",
                linkedinUrl: url,
                dryRun,
                ok: res.ok,
                detail: res.ok ? res.mode : res.error,
                sentAt: now,
              };
              results.push(row);
              writer.log({ ts: now, type: "send", ...row });
            } catch (err) {
              if (err instanceof SafetyLimitError) {
                console.warn(`Connect cap hit: ${err.message}`);
                results.push({
                  leadId: lead.id,
                  companyName: lead.companyName,
                  personName: lead.personName,
                  action: "linkedin_connect",
                  linkedinUrl: url,
                  dryRun,
                  ok: false,
                  detail: err.message,
                  sentAt: now,
                });
                break;
              }
              const msg = err instanceof Error ? err.message : String(err);
              results.push({
                leadId: lead.id,
                companyName: lead.companyName,
                personName: lead.personName,
                action: "linkedin_connect",
                linkedinUrl: url,
                dryRun,
                ok: false,
                detail: msg,
                sentAt: now,
              });
            }
            await humanDelay("between_companies");
          }
        },
        { jobId: "lead-send-outreach" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`LinkedIn session failed: ${msg}`);
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.leadsSent), results);
  ensureRunMeta(runDir, runId, config, "lead-send-outreach");

  const okN = results.filter((r) => r.ok).length;
  const emailN = results.filter((r) => r.action === "email").length;
  const connectN = results.filter((r) => r.action === "linkedin_connect").length;
  const skipN = results.filter((r) => r.action === "skip").length;

  console.log(
    `\nSend summary: ${okN}/${results.length} ok — connect=${connectN}, email=${emailN}, skip=${skipN} (dryRun=${dryRun})`,
  );
  console.log(`→ data/leads/${runId}/${ARTIFACTS.leadsSent}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  return {
    exitCode: 0,
    message: `Processed ${results.length} (connect ${connectN}, email ${emailN}, skip ${skipN})`,
  };
}
