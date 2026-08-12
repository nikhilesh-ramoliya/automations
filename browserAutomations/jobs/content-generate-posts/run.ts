import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  envInt,
  isContentDryRun,
  snapshotContentConfigFromEnv,
} from "../../lib/content/env.js";
import {
  artifactPath,
  ensureContentMeta,
  loadTopics,
  markContentStep,
  resolveContentOutputDir,
  resolveContentRunDir,
  writeJson,
} from "../../lib/content/io.js";
import {
  formatDraftForLinkedIn,
  generatePostsForTopics,
} from "../../lib/content/posts.js";
import { loadContentInstructions } from "../../lib/content/instructions.js";
import { CONTENT_ARTIFACTS } from "../../lib/content/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isContentDryRun();
  const maxVariations = Math.max(
    1,
    Math.min(5, envInt("CONTENT_MAX_VARIATIONS", 1)),
  );
  const maxTopics = envInt("CONTENT_MAX_TOPICS", 8);
  const minScore = envInt("CONTENT_MIN_SCORE", 55);
  const config = snapshotContentConfigFromEnv();
  const { runId, runDir } = resolveContentRunDir({ createIfMissing: false });
  ensureContentMeta(runDir, runId, config);

  const logPath = jobLogPath("content-generate-posts");
  const writer = createJsonlLogger(logPath);

  const topics = loadTopics(runDir);
  if (topics.length === 0) {
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message:
        "No topics.json found. Run content-research-topics first (or set CONTENT_RUN_ID).",
    };
  }

  const instructions = loadContentInstructions();
  console.log(
    `Instructions: ${instructions.path}${instructions.usingDefaults ? " (defaults)" : ""}`,
  );

  const { drafts, usedAi } = await generatePostsForTopics({
    topics,
    maxVariations,
    maxTopics,
  });

  writeJson(artifactPath(runDir, CONTENT_ARTIFACTS.drafts), drafts);

  const outDir = resolveContentOutputDir(runId);
  writeJson(path.join(outDir, "drafts.json"), drafts);

  const textPath = path.join(outDir, "drafts.txt");
  const text = drafts
    .map(
      (d, i) =>
        `── Draft ${i + 1}: ${d.topic} [${d.angle}] score=${d.score} status=${d.status} ──\n\n` +
        `${formatDraftForLinkedIn(d)}\n`,
    )
    .join("\n");
  fs.writeFileSync(textPath, text + "\n", "utf8");

  markContentStep(runDir, "content-generate-posts");

  const aboveMin = drafts.filter((d) => d.score >= minScore).length;
  writer.log({
    ts: new Date().toISOString(),
    type: "drafts_complete",
    runId,
    count: drafts.length,
    aboveMinScore: aboveMin,
    minScore,
    usedAi,
    dryRun,
  });
  await writer.close();

  console.log(
    `\nGenerated ${drafts.length} drafts (${usedAi ? "AI" : "templates"}) → ${outDir}\\drafts.txt\n`,
  );
  console.log(
    `  Scores ≥ ${minScore}: ${aboveMin}/${drafts.length} (all persisted as status=draft)\n`,
  );
  for (const d of drafts.slice(0, 8)) {
    console.log(
      `  • [${d.score}] ${d.angle} — ${d.content.slice(0, 72).replace(/\n/g, " ")}…`,
    );
  }
  if (drafts.length > 8) {
    console.log(`  … +${drafts.length - 8} more`);
  }

  return {
    exitCode: 0,
    message: `drafts=${drafts.length} aboveMin=${aboveMin} source=${usedAi ? "ai" : "template"}`,
  };
}
