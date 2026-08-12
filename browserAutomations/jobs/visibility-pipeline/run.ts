import "dotenv/config";
import type { JobRunResult } from "../../lib/job-types.js";
import {
  hasLinkedInAuth,
  withLinkedInPage,
} from "../../lib/leads/browser.js";
import { SafetyLimitError, remainingCap } from "../../lib/linkedin-safety.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  envBool,
  envInt,
  isVisibilityDryRun,
  pickIcpQueriesForRun,
  snapshotVisibilityConfigFromEnv,
  visibilityCommentMinScore,
  visibilityConnectMinLeadScore,
  visibilityDelayMs,
  visibilityLikeMinScore,
  visibilitySearchKeywords,
} from "../../lib/visibility/env.js";
import {
  artifactPath,
  ensureVisibilityMeta,
  loadEngagements,
  loadPosts,
  loadRecentEngagedPostIds,
  loadRecentTargetProfileUrls,
  loadTargets,
  markVisibilityStep,
  normalizeUrl,
  postKey,
  resolveVisibilityRunDir,
  writeJson,
} from "../../lib/visibility/io.js";
import { runVisibilityLinkedInSession } from "../../lib/visibility/session.js";
import { runTargetedEngage } from "../../lib/visibility/targeted.js";
import {
  VISIBILITY_ARTIFACTS,
  type EngagementRecord,
  type FoundPost,
  type TargetPerson,
} from "../../lib/visibility/types.js";

/**
 * Personal-brand visibility.
 * Default: content search → like/comment → connect only on strong software-dev lead-fit.
 * Optional: VISIBILITY_TARGETED=true → ICP people engage.
 */
const CONTENT_STEPS = [
  "visibility-find-posts",
  "visibility-engage",
  "visibility-draft-posts",
] as const;

const TARGETED_STEPS = [
  "visibility-targeted-engage",
  "visibility-draft-posts",
] as const;

type StepId =
  | (typeof CONTENT_STEPS)[number]
  | (typeof TARGETED_STEPS)[number];

function sliceSteps(all: readonly StepId[]): StepId[] {
  const from = process.env.VISIBILITY_PIPELINE_FROM?.trim() as
    | StepId
    | undefined;
  const to = process.env.VISIBILITY_PIPELINE_TO?.trim() as StepId | undefined;
  let steps = [...all];
  if (from) {
    const i = steps.indexOf(from);
    if (i < 0) throw new Error(`Unknown VISIBILITY_PIPELINE_FROM=${from}`);
    steps = steps.slice(i);
  }
  if (to) {
    const i = steps.indexOf(to);
    if (i < 0) throw new Error(`Unknown VISIBILITY_PIPELINE_TO=${to}`);
    steps = steps.slice(0, i + 1);
  }
  return steps;
}

function mergePosts(existing: FoundPost[], incoming: FoundPost[]): FoundPost[] {
  const map = new Map<string, FoundPost>();
  for (const p of existing) map.set(postKey(p), p);
  for (const p of incoming) {
    const key = postKey(p);
    if (!map.has(key)) map.set(key, p);
  }
  return [...map.values()];
}

function mergeEngagements(
  prior: EngagementRecord[],
  incoming: EngagementRecord[],
): EngagementRecord[] {
  const map = new Map<string, EngagementRecord>();
  for (const e of prior) map.set(e.postId, e);
  for (const e of incoming) map.set(e.postId, e);
  return [...map.values()];
}

function mergeTargets(
  prior: TargetPerson[],
  incoming: TargetPerson[],
): TargetPerson[] {
  const map = new Map<string, TargetPerson>();
  for (const t of prior) {
    map.set(normalizeUrl(t.profileUrl) || t.id, t);
  }
  for (const t of incoming) {
    map.set(normalizeUrl(t.profileUrl) || t.id, t);
  }
  return [...map.values()];
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isVisibilityDryRun();
  process.env.VISIBILITY_DRY_RUN = dryRun ? "true" : "false";
  process.env.DRY_RUN = dryRun ? "true" : "false";

  const targeted = envBool("VISIBILITY_TARGETED", false);
  const steps = sliceSteps(targeted ? TARGETED_STEPS : CONTENT_STEPS);
  const doTargeted = steps.includes("visibility-targeted-engage");
  const doFind = steps.includes("visibility-find-posts");
  const doEngage = steps.includes("visibility-engage");
  const doDraft = steps.includes("visibility-draft-posts");

  console.log("\n════════════════════════════════════════");
  console.log(" Visibility pipeline (personal brand)");
  console.log(
    dryRun
      ? " Mode: dry-run (react OK; comments typed not sent; connects dry-run)"
      : " Mode: LIVE (comments + high-lead-fit connects will send)",
  );
  console.log(
    targeted
      ? " Strategy: targeted ICP people (optional)"
      : " Strategy: content posts → like/comment; connect only if strong software-dev lead fit",
  );
  console.log(` Steps:   ${steps.join(" → ")}`);
  console.log("════════════════════════════════════════\n");

  const results: { step: string; exitCode: number; message?: string }[] = [];
  const config = snapshotVisibilityConfigFromEnv();
  const { runId, runDir } = resolveVisibilityRunDir({ createIfMissing: true });
  ensureVisibilityMeta(runDir, runId, config);

  const logPath = jobLogPath("visibility-pipeline");
  const writer = createJsonlLogger(logPath);

  if (doTargeted || doFind || doEngage) {
    if (!hasLinkedInAuth()) {
      await writer.close();
      return {
        exitCode: 1,
        message: "Not authenticated. Run `npm run auth:linkedin`.",
      };
    }
  }

  if (doTargeted) {
    const queries = pickIcpQueriesForRun();
    const delayMs = visibilityDelayMs();
    const likeMin = visibilityLikeMinScore();
    const commentMin = visibilityCommentMinScore();
    const maxProfiles = envInt("VISIBILITY_MAX_PROFILES", 12);
    const maxReactions = envInt("VISIBILITY_MAX_REACTIONS", 12);
    const maxComments = envInt("VISIBILITY_MAX_COMMENTS", 6);
    const maxConnects = envInt("VISIBILITY_MAX_CONNECTS", 5);
    const maxCards = envInt("VISIBILITY_MAX_CARDS_PER_PROFILE", 8);
    const priorTargets = loadTargets(runDir);
    const prior = loadEngagements(runDir);
    const skipProfiles = loadRecentTargetProfileUrls(8);
    const skipPosts = loadRecentEngagedPostIds(8);

    console.log(` ICP queries: ${queries.join(" | ")}`);
    console.log(
      `\n── ▶ LinkedIn targeted session (profiles≤${maxProfiles}) ──\n`,
    );

    try {
      await withLinkedInPage(
        async (page) => {
          const result = await runTargetedEngage(page, {
            queries,
            dryRun,
            delayMs,
            maxProfiles,
            maxReactions: Math.min(maxReactions, remainingCap("reaction")),
            maxComments: Math.min(maxComments, remainingCap("message")),
            maxConnects: Math.min(maxConnects, remainingCap("connect")),
            maxCardsPerProfile: maxCards,
            likeMinScore: likeMin,
            commentMinScore: commentMin,
            doReact: envBool("VISIBILITY_DO_REACT", true),
            doComment: envBool("VISIBILITY_DO_COMMENT", true),
            doConnect: envBool("VISIBILITY_DO_CONNECT", true),
            skipProfileUrls: skipProfiles,
            skipPostIds: skipPosts,
            onEngagement: (record) => {
              writer.log({
                ts: new Date().toISOString(),
                type: "engagement",
                postId: record.postId,
                target: record.targetName,
                score: record.relevanceScore,
                reacted: record.reacted,
                commented: record.commentDrafted || record.commentSent,
              });
            },
          });

          writeJson(
            artifactPath(runDir, VISIBILITY_ARTIFACTS.targets),
            mergeTargets(priorTargets, result.targets),
          );
          writeJson(
            artifactPath(runDir, VISIBILITY_ARTIFACTS.posts),
            mergePosts(loadPosts(runDir), result.posts),
          );
          writeJson(
            artifactPath(runDir, VISIBILITY_ARTIFACTS.engagements),
            mergeEngagements(prior, result.engagements),
          );
          markVisibilityStep(runDir, "visibility-targeted-engage");
          results.push({
            step: "visibility-targeted-engage",
            exitCode: 0,
            message:
              `profiles=${result.profilesViewed},reactions=${result.reactions},` +
              `comments=${result.comments},connects=${result.connects}`,
          });
        },
        { jobId: "visibility-pipeline" },
      );
    } catch (err) {
      if (err instanceof SafetyLimitError) {
        results.push({
          step: "visibility-targeted-engage",
          exitCode: 0,
          message: err.message,
        });
      } else {
        await writer.close();
        throw err;
      }
    }
  } else if (doFind || doEngage) {
    const keywords = visibilitySearchKeywords();
    console.log(` Search term(s): ${keywords.join(" | ")}`);
    const delayMs = visibilityDelayMs();
    const likeMin = visibilityLikeMinScore();
    const commentMin = visibilityCommentMinScore();
    const maxPosts = envInt("VISIBILITY_MAX_POSTS", 15);
    const maxReactions = envInt("VISIBILITY_MAX_REACTIONS", 10);
    const maxComments = envInt("VISIBILITY_MAX_COMMENTS", 5);
    const maxScan = envInt("VISIBILITY_MAX_SCAN", 25);
    const maxConnects = envBool("VISIBILITY_DO_CONNECT", true)
      ? envInt("VISIBILITY_MAX_CONNECTS", 3)
      : 0;
    const connectMinLead = visibilityConnectMinLeadScore();
    const prior = loadEngagements(runDir);
    const skipIds = loadRecentEngagedPostIds(8);
    for (const e of prior) {
      if (e.reacted || e.commentSent || e.commentDrafted) skipIds.add(e.postId);
    }
    const liveEngagements: EngagementRecord[] = [];

    console.log(
      `\n── ▶ LinkedIn content session (find=${doFind}, engage=${doEngage}) ──\n` +
        `  connect if leadFit≥${connectMinLead} (max ${maxConnects})\n`,
    );

    try {
      await withLinkedInPage(
        async (page) => {
          const session = await runVisibilityLinkedInSession(page, {
            keywords,
            delayMs,
            dryRun,
            doFind,
            doEngage,
            maxPosts,
            maxReactions: Math.min(maxReactions, remainingCap("reaction")),
            maxComments: Math.min(maxComments, remainingCap("message")),
            maxCardsToScan: maxScan,
            likeMinScore: likeMin,
            commentMinScore: commentMin,
            connectMinLeadScore: connectMinLead,
            maxConnects: Math.min(maxConnects, remainingCap("connect")),
            skipEngagementIds: skipIds,
            onPosts: (batch) => {
              writeJson(
                artifactPath(runDir, VISIBILITY_ARTIFACTS.posts),
                mergePosts(loadPosts(runDir), batch),
              );
            },
            onEngagement: (record) => {
              liveEngagements.push(record);
              writeJson(
                artifactPath(runDir, VISIBILITY_ARTIFACTS.engagements),
                mergeEngagements(prior, liveEngagements),
              );
              writer.log({
                ts: new Date().toISOString(),
                type: "engagement",
                postId: record.postId,
                score: record.relevanceScore,
                leadFit: record.leadFitScore,
                reacted: record.reacted,
                commentDrafted: record.commentDrafted,
              });
            },
          });

          writeJson(
            artifactPath(runDir, VISIBILITY_ARTIFACTS.posts),
            mergePosts(loadPosts(runDir), session.posts),
          );
          writeJson(
            artifactPath(runDir, VISIBILITY_ARTIFACTS.engagements),
            mergeEngagements(prior, session.engagements),
          );

          if (doFind) {
            markVisibilityStep(runDir, "visibility-find-posts");
            results.push({
              step: "visibility-find-posts",
              exitCode: 0,
              message: `posts=${session.posts.length}`,
            });
          }
          if (doEngage) {
            markVisibilityStep(runDir, "visibility-engage");
            results.push({
              step: "visibility-engage",
              exitCode: 0,
              message:
                `reactions=${session.reactions},comments=${session.comments},` +
                `connects=${session.connects},skipped=${session.skipped}`,
            });
          }
        },
        { jobId: "visibility-pipeline" },
      );
    } catch (err) {
      if (err instanceof SafetyLimitError) {
        results.push({
          step: doEngage ? "visibility-engage" : "visibility-find-posts",
          exitCode: 0,
          message: err.message,
        });
      } else {
        await writer.close();
        throw err;
      }
    }
  }

  if (doDraft) {
    console.log("\n── ▶ visibility-draft-posts ──\n");
    const { run: draftRun } = await import("../visibility-draft-posts/run.js");
    const draftResult = await draftRun();
    results.push({
      step: "visibility-draft-posts",
      exitCode: draftResult.exitCode,
      message: draftResult.message,
    });
  }

  console.log("\n════════════════════════════════════════");
  console.log(" Visibility pipeline complete");
  for (const r of results) {
    console.log(
      `  ${r.exitCode === 0 ? "✓" : "✗"} ${r.step}${r.message ? ` — ${r.message}` : ""}`,
    );
  }
  console.log("════════════════════════════════════════\n");

  await writer.close();
  const failed = results.find((r) => r.exitCode !== 0);
  return {
    exitCode: failed?.exitCode ?? 0,
    message: failed?.message ?? `completed ${results.length} steps (${runId})`,
  };
}
