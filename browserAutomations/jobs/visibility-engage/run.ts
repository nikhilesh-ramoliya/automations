import "dotenv/config";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  hasLinkedInAuth,
  withLinkedInPage,
} from "../../lib/leads/browser.js";
import { SafetyLimitError, remainingCap } from "../../lib/linkedin-safety.js";
import { scrollAndEngage } from "../../lib/visibility/engage.js";
import {
  envInt,
  isVisibilityDryRun,
  snapshotVisibilityConfigFromEnv,
  visibilityCommentMinScore,
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
  markVisibilityStep,
  postKey,
  resolveVisibilityRunDir,
  writeJson,
} from "../../lib/visibility/io.js";
import {
  VISIBILITY_ARTIFACTS,
  type EngagementRecord,
  type FoundPost,
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

export async function run(): Promise<JobRunResult> {
  const dryRun = isVisibilityDryRun();
  const maxReactions = envInt("VISIBILITY_MAX_REACTIONS", 10);
  const maxComments = envInt("VISIBILITY_MAX_COMMENTS", 5);
  const maxScan = envInt("VISIBILITY_MAX_SCAN", 25);
  const likeMin = visibilityLikeMinScore();
  const commentMin = visibilityCommentMinScore();
  const delayMs = visibilityDelayMs();
  const keywords = visibilitySearchKeywords();
  const config = snapshotVisibilityConfigFromEnv();
  const { runId, runDir } = resolveVisibilityRunDir({ createIfMissing: true });
  ensureVisibilityMeta(runDir, runId, config);

  const logPath = jobLogPath("visibility-engage");
  const writer = createJsonlLogger(logPath);

  const prior = loadEngagements(runDir);
  const skipIds = loadRecentEngagedPostIds(8);
  for (const e of prior) {
    if (e.reacted || e.commentSent || e.commentDrafted) skipIds.add(e.postId);
  }
  const reactBudget = Math.min(maxReactions, remainingCap("reaction"));
  const commentBudget = Math.min(maxComments, remainingCap("message"));

  console.log(
    `\nHuman-like engage (scroll → score → selective action)\n` +
      `  dryRun=${dryRun} (react OK; comments typed${!dryRun ? "+sent" : ", not sent"})\n` +
      `  like if score≥${likeMin}; comment if score≥${commentMin}\n` +
      `  budgets: reactions≤${reactBudget}, comments≤${commentBudget}, scan≤${maxScan}\n` +
      `  keywords: ${keywords.join("|")}\n`,
  );

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "Not authenticated. Run `npm run auth:linkedin`.",
    };
  }

  if (reactBudget <= 0 && commentBudget <= 0) {
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No reaction/comment budget remaining today.",
    };
  }

  let engagements: EngagementRecord[] = [...prior];
  let reactions = 0;
  let comments = 0;
  let skipped = 0;

  try {
    await withLinkedInPage(
      async (page) => {
        const live: EngagementRecord[] = [];
        const result = await scrollAndEngage(page, {
          keywords,
          dryRun,
          delayMs,
          maxReactions: reactBudget,
          maxComments: commentBudget,
          maxCardsToScan: maxScan,
          likeMinScore: likeMin,
          commentMinScore: commentMin,
          skipIds,
          onEngagement: (record, post) => {
            live.push(record);
            writer.log({
              ts: new Date().toISOString(),
              type: "engagement",
              postId: post.id,
              score: record.relevanceScore,
              reacted: record.reacted,
              commentDrafted: record.commentDrafted,
              commentSent: record.commentSent,
              notes: record.notes,
            });
            writeJson(
              artifactPath(runDir, VISIBILITY_ARTIFACTS.engagements),
              mergeEngagements(prior, live),
            );
          },
        });

        engagements = mergeEngagements(prior, result.engagements);
        reactions = result.reactions;
        comments = result.comments;
        skipped = result.skipped;

        writeJson(
          artifactPath(runDir, VISIBILITY_ARTIFACTS.posts),
          mergePosts(loadPosts(runDir), result.postsSeen),
        );
      },
      { jobId: "visibility-engage" },
    );
  } catch (err) {
    if (err instanceof SafetyLimitError) {
      writeJson(
        artifactPath(runDir, VISIBILITY_ARTIFACTS.engagements),
        engagements,
      );
      markVisibilityStep(runDir, "visibility-engage");
      await writer.close();
      return { exitCode: 0, softSuccess: true, message: err.message };
    }
    await writer.close();
    throw err;
  }

  writeJson(artifactPath(runDir, VISIBILITY_ARTIFACTS.engagements), engagements);
  markVisibilityStep(runDir, "visibility-engage");

  writer.log({
    ts: new Date().toISOString(),
    type: "engage_complete",
    runId,
    reactions,
    comments,
    skipped,
    likeMin,
    commentMin,
    dryRun,
  });
  await writer.close();

  console.log(
    `Done: liked=${reactions}, commentsTyped=${comments}, skipped=${skipped}` +
      (dryRun ? " (comments not sent — dry-run)" : ""),
  );

  return {
    exitCode: 0,
    message: `reactions=${reactions},comments=${comments},skipped=${skipped}`,
  };
}
