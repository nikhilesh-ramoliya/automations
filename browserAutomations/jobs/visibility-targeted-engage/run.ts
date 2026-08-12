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
  visibilityDelayMs,
  visibilityLikeMinScore,
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
import { runTargetedEngage } from "../../lib/visibility/targeted.js";
import {
  VISIBILITY_ARTIFACTS,
  type EngagementRecord,
  type FoundPost,
  type TargetPerson,
} from "../../lib/visibility/types.js";

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
    const k = normalizeUrl(t.profileUrl) || t.id;
    map.set(k, t);
  }
  for (const t of incoming) {
    const k = normalizeUrl(t.profileUrl) || t.id;
    map.set(k, t);
  }
  return [...map.values()];
}

export async function run(): Promise<JobRunResult> {
  const dryRun = isVisibilityDryRun();
  process.env.VISIBILITY_DRY_RUN = dryRun ? "true" : "false";
  process.env.DRY_RUN = dryRun ? "true" : "false";

  const queries = pickIcpQueriesForRun();
  const maxProfiles = envInt("VISIBILITY_MAX_PROFILES", 12);
  const maxReactions = envInt("VISIBILITY_MAX_REACTIONS", 12);
  const maxComments = envInt("VISIBILITY_MAX_COMMENTS", 6);
  const maxConnects = envInt("VISIBILITY_MAX_CONNECTS", 5);
  const maxCards = envInt("VISIBILITY_MAX_CARDS_PER_PROFILE", 8);
  const likeMin = visibilityLikeMinScore();
  const commentMin = visibilityCommentMinScore();
  const delayMs = visibilityDelayMs();
  const doReact = envBool("VISIBILITY_DO_REACT", true);
  const doComment = envBool("VISIBILITY_DO_COMMENT", true);
  const doConnect = envBool("VISIBILITY_DO_CONNECT", true);

  const config = snapshotVisibilityConfigFromEnv();
  const { runId, runDir } = resolveVisibilityRunDir({ createIfMissing: true });
  ensureVisibilityMeta(runDir, runId, config);

  const logPath = jobLogPath("visibility-targeted-engage");
  const writer = createJsonlLogger(logPath);

  console.log("\n════════════════════════════════════════");
  console.log(" Targeted engage (ICP people → posts)");
  console.log(
    dryRun
      ? " Mode: dry-run (react OK; comments typed not sent; connects dry-run)"
      : " Mode: LIVE (comments + connects will send)",
  );
  console.log(` Queries: ${queries.join(" | ")}`);
  console.log(
    ` Budgets: profiles≤${maxProfiles}, reactions≤${maxReactions}, comments≤${maxComments}, connects≤${maxConnects}`,
  );
  console.log("════════════════════════════════════════\n");

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "Not authenticated. Run `npm run auth:linkedin`.",
    };
  }

  const priorTargets = loadTargets(runDir);
  const priorEng = loadEngagements(runDir);
  const skipProfiles = loadRecentTargetProfileUrls(8);
  const skipPosts = loadRecentEngagedPostIds(8);
  for (const e of priorEng) {
    if (e.reacted || e.commentSent || e.commentDrafted) skipPosts.add(e.postId);
  }

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
          doReact,
          doComment,
          doConnect,
          skipProfileUrls: skipProfiles,
          skipPostIds: skipPosts,
          onTarget: (t) => {
            writeJson(
              artifactPath(runDir, VISIBILITY_ARTIFACTS.targets),
              mergeTargets(priorTargets, [...loadTargets(runDir), t]),
            );
          },
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
          mergeEngagements(priorEng, result.engagements),
        );
        markVisibilityStep(runDir, "visibility-targeted-engage");

        console.log(
          `\nDone: profiles=${result.profilesViewed}, reactions=${result.reactions}, ` +
            `comments=${result.comments}, connects=${result.connects}, skipped=${result.skipped}\n`,
        );
      },
      { jobId: "visibility-targeted-engage" },
    );
  } catch (err) {
    if (err instanceof SafetyLimitError) {
      await writer.close();
      return { exitCode: 0, message: err.message };
    }
    await writer.close();
    throw err;
  }

  await writer.close();
  return {
    exitCode: 0,
    message: `targeted engage complete (${runId})`,
  };
}
