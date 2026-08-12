import "dotenv/config";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  hasLinkedInAuth,
  withLinkedInPage,
} from "../../lib/leads/browser.js";
import { SafetyLimitError } from "../../lib/linkedin-safety.js";
import {
  envInt,
  isVisibilityDryRun,
  snapshotVisibilityConfigFromEnv,
  visibilityDelayMs,
  visibilitySearchKeywords,
} from "../../lib/visibility/env.js";
import {
  artifactPath,
  ensureVisibilityMeta,
  loadPosts,
  markVisibilityStep,
  postKey,
  resolveVisibilityRunDir,
  writeJson,
} from "../../lib/visibility/io.js";
import { findRelatedPosts } from "../../lib/visibility/posts.js";
import {
  VISIBILITY_ARTIFACTS,
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

export async function run(): Promise<JobRunResult> {
  const dryRun = isVisibilityDryRun();
  const maxPosts = envInt("VISIBILITY_MAX_POSTS", 15);
  const delayMs = visibilityDelayMs();
  const keywords = visibilitySearchKeywords();
  const config = snapshotVisibilityConfigFromEnv();
  const { runId, runDir } = resolveVisibilityRunDir({ createIfMissing: true });
  ensureVisibilityMeta(runDir, runId, config);

  const logPath = jobLogPath("visibility-find-posts");
  const writer = createJsonlLogger(logPath);

  console.log(
    `\nFind posts for visibility (max=${maxPosts}, dryRun=${dryRun}, search=${keywords.join("|")})\n`,
  );

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "Not authenticated. Run `npm run auth:linkedin`.",
    };
  }

  const existing = loadPosts(runDir);
  let found: FoundPost[] = [];

  try {
    found = await withLinkedInPage(
      async (page) =>
        findRelatedPosts(page, keywords, { maxPosts, delayMs }),
      { jobId: "visibility-find-posts" },
    );
  } catch (err) {
    if (err instanceof SafetyLimitError) {
      const merged = mergePosts(existing, found);
      writeJson(artifactPath(runDir, VISIBILITY_ARTIFACTS.posts), merged);
      markVisibilityStep(runDir, "visibility-find-posts");
      writer.log({
        ts: new Date().toISOString(),
        type: "safety_limit",
        message: err.message,
      });
      await writer.close();
      return { exitCode: 0, softSuccess: true, message: err.message };
    }
    await writer.close();
    throw err;
  }

  const merged = mergePosts(existing, found);
  writeJson(artifactPath(runDir, VISIBILITY_ARTIFACTS.posts), merged);
  markVisibilityStep(runDir, "visibility-find-posts");

  writer.log({
    ts: new Date().toISOString(),
    type: "find_complete",
    runId,
    found: found.length,
    total: merged.length,
    dryRun,
  });
  await writer.close();

  console.log(
    `Wrote ${merged.length} posts (${found.length} new) → ${runDir}`,
  );

  if (merged.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No posts found.",
    };
  }

  return { exitCode: 0, message: `posts=${merged.length}` };
}
