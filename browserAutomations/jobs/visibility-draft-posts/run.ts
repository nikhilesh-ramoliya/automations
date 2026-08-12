import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  buildPostDrafts,
  formatDraftForLinkedIn,
} from "../../lib/visibility/drafts.js";
import {
  envInt,
  isVisibilityDryRun,
  snapshotVisibilityConfigFromEnv,
  visibilityKeywords,
} from "../../lib/visibility/env.js";
import {
  artifactPath,
  ensureVisibilityMeta,
  loadPosts,
  markVisibilityStep,
  resolveVisibilityOutputDir,
  resolveVisibilityRunDir,
  writeJson,
} from "../../lib/visibility/io.js";
import { VISIBILITY_ARTIFACTS } from "../../lib/visibility/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isVisibilityDryRun();
  const maxDrafts = envInt("VISIBILITY_MAX_DRAFTS", 5);
  const keywords = visibilityKeywords();
  const config = snapshotVisibilityConfigFromEnv();
  const { runId, runDir } = resolveVisibilityRunDir({ createIfMissing: true });
  ensureVisibilityMeta(runDir, runId, config);

  const logPath = jobLogPath("visibility-draft-posts");
  const writer = createJsonlLogger(logPath);

  const posts = loadPosts(runDir);
  const drafts = buildPostDrafts({ keywords, posts, maxDrafts });

  writeJson(artifactPath(runDir, VISIBILITY_ARTIFACTS.drafts), drafts);

  const outDir = resolveVisibilityOutputDir(runId);
  writeJson(path.join(outDir, "drafts.json"), drafts);
  const textPath = path.join(outDir, "drafts.txt");
  const text = drafts
    .map(
      (d, i) =>
        `── Draft ${i + 1}: ${d.topic} ──\n\n${formatDraftForLinkedIn(d)}\n`,
    )
    .join("\n");
  fs.writeFileSync(textPath, text + "\n", "utf8");

  markVisibilityStep(runDir, "visibility-draft-posts");

  writer.log({
    ts: new Date().toISOString(),
    type: "drafts_complete",
    runId,
    count: drafts.length,
    dryRun,
  });
  await writer.close();

  console.log(`\nDrafted ${drafts.length} posts → ${outDir}\\drafts.txt\n`);
  for (const d of drafts) {
    console.log(`  • [${d.topic}] ${d.body.slice(0, 80).replace(/\n/g, " ")}…`);
  }

  return { exitCode: 0, message: `drafts=${drafts.length}` };
}
