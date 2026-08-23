import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import {
  envBool,
  envInt,
  isConnectionFollowupDryRun,
  readSupabaseConfig,
  requireServiceRoleKey,
} from "../../lib/connections/env.js";
import {
  deleteConnection,
  fetchPendingConnections,
  testSupabaseConnection,
} from "../../lib/connections/supabase.js";
import type { ConnectionFollowupResult } from "../../lib/connections/types.js";
import {
  draftConnectionMessage,
  isSkippableProfile,
} from "../../lib/connections/message.js";
import { hasLinkedInAuth, withLinkedInPage } from "../../lib/leads/browser.js";
import {
  closeMessageOverlays,
  messageAcceptedConnection,
} from "../../lib/leads/linkedin-message.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  SafetyLimitError,
  humanDelay,
  remainingCap,
} from "../../lib/linkedin-safety.js";

const RESULTS_DIR = path.join("data", "connections");

export async function run(): Promise<JobRunResult> {
  const dryRun = isConnectionFollowupDryRun();
  const max = envInt("CONNECTION_FOLLOWUP_MAX", 20);
  const onlyAccepted = envBool("CONNECTION_FOLLOWUP_ONLY_ACCEPTED", true);
  const quickCheck = envBool("CONNECTION_FOLLOWUP_QUICK", true);
  const messageTemplate = process.env.CONNECTION_FOLLOWUP_MESSAGE?.trim();

  const supabase = readSupabaseConfig();
  if (!supabase) {
    return {
      exitCode: 1,
      message:
        "Supabase not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.",
    };
  }

  try {
    requireServiceRoleKey(dryRun);
  } catch (err) {
    return {
      exitCode: 1,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await testSupabaseConnection({
      url: supabase.url,
      key: supabase.publishableKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, message: `Supabase connection test failed: ${msg}` };
  }

  let pending: Awaited<ReturnType<typeof fetchPendingConnections>>;
  try {
    pending = await fetchPendingConnections(
      { url: supabase.url, key: supabase.publishableKey },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, message: `Supabase fetch failed: ${msg}` };
  }

  if (pending.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message:
        "No pending connection_requests in Supabase — extension capture queue is empty.",
    };
  }

  const msgLeft = remainingCap("message");
  const batchCap = Math.min(max, pending.length, Math.max(0, msgLeft));
  if (batchCap === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: `Message daily cap reached (remaining=${msgLeft}).`,
    };
  }

  const batch = pending.slice(0, batchCap);
  const logPath = jobLogPath("connection-followup-message");
  const writer = createJsonlLogger(logPath);
  const now = new Date().toISOString();
  const results: ConnectionFollowupResult[] = [];

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "LinkedIn session missing. Run `npm run auth:linkedin`.",
    };
  }

  console.log(
    `\nConnection follow-up (Supabase → LinkedIn DM): up to ${batch.length} (dryRun=${dryRun}, onlyAccepted=${onlyAccepted}, quick=${quickCheck})\n`,
  );

  let hitCap = false;

  try {
    await withLinkedInPage(
      async (page) => {
        for (const row of batch) {
          const skipReason = isSkippableProfile(row.profile_url, row.full_name);
          if (skipReason) {
            console.log(`  ⊘ Skip ${row.full_name}: ${skipReason}`);
            const skip: ConnectionFollowupResult = {
              id: row.id,
              profileUrl: row.profile_url,
              fullName: row.full_name,
              status: "skipped",
              detail: skipReason,
              dryRun,
              ok: true,
              followedUpAt: now,
            };
            results.push(skip);
            writer.log({ ts: now, type: "connection_followup", ...skip });
            continue;
          }

          const messageBody = draftConnectionMessage({
            fullName: row.full_name,
            template: messageTemplate,
          });

          console.log(`  → Checking ${row.full_name}…`);

          try {
            await closeMessageOverlays(page);
            const res = await messageAcceptedConnection(page, {
              profileUrl: row.profile_url,
              message: messageBody,
              dryRun,
              onlyAccepted,
              quickCheck,
            });

            let deletedFromSupabase = false;

            if (
              res.ok &&
              res.status === "messaged" &&
              res.detail === "sent" &&
              !dryRun
            ) {
              const serviceKey = requireServiceRoleKey(false)!;
              await deleteConnection(
                { url: supabase.url, key: serviceKey },
                row.id,
              );
              deletedFromSupabase = true;
              console.log(
                `  ✓ Messaged ${row.full_name} — removed from Supabase`,
              );
            }

            const out: ConnectionFollowupResult = res.ok
              ? {
                  id: row.id,
                  profileUrl: row.profile_url,
                  fullName: row.full_name,
                  status: res.status,
                  detail: res.detail,
                  messagePreview: res.messagePreview,
                  deletedFromSupabase,
                  dryRun,
                  ok: true,
                  followedUpAt: now,
                }
              : {
                  id: row.id,
                  profileUrl: row.profile_url,
                  fullName: row.full_name,
                  status: "error",
                  detail: res.error,
                  dryRun,
                  ok: false,
                  followedUpAt: now,
                };
            results.push(out);
            writer.log({ ts: now, type: "connection_followup", ...out });
            const label = out.status === "messaged" ? "✓" : out.status === "pending" ? "⏳" : "○";
            console.log(`  ${label} ${row.full_name}: ${out.detail ?? out.status}`);
          } catch (err) {
            if (err instanceof SafetyLimitError) {
              console.warn(`Message/safety cap hit: ${err.message}`);
              hitCap = true;
              results.push({
                id: row.id,
                profileUrl: row.profile_url,
                fullName: row.full_name,
                status: "error",
                detail: err.message,
                dryRun,
                ok: false,
                followedUpAt: now,
              });
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ✗ ${row.full_name}: ${msg}`);
            results.push({
              id: row.id,
              profileUrl: row.profile_url,
              fullName: row.full_name,
              status: "error",
              detail: msg,
              dryRun,
              ok: false,
              followedUpAt: now,
            });
          }

          await humanDelay("between_companies", quickCheck ? { skipBurstCheck: true, minMs: 2000 } : undefined);
        }
      },
      { jobId: "connection-followup-message" },
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

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = now.replace(/[:.]/g, "-");
  const resultsPath = path.join(RESULTS_DIR, `followup-${stamp}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

  const messagedN = results.filter((r) => r.status === "messaged").length;
  const pendingN = results.filter((r) => r.status === "pending").length;
  const skippedN = results.filter((r) => r.status === "skipped").length;
  const errorN = results.filter((r) => r.status === "error").length;
  const deletedN = results.filter((r) => r.deletedFromSupabase).length;

  console.log(
    `\nSummary: messaged=${messagedN}, deleted=${deletedN}, pending=${pendingN}, skipped=${skippedN}, error=${errorN} (dryRun=${dryRun})`,
  );
  console.log(`→ ${resultsPath}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (hitCap) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: `Processed ${results.length} (cap hit). messaged=${messagedN} deleted=${deletedN}`,
    };
  }

  return {
    exitCode: 0,
    message: `Processed ${results.length}: messaged=${messagedN} deleted=${deletedN} pending=${pendingN} skipped=${skippedN} error=${errorN}`,
  };
}
