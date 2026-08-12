import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  contentAudiences,
  contentCategories,
  envInt,
  isContentDryRun,
  snapshotContentConfigFromEnv,
} from "../../lib/content/env.js";
import {
  artifactPath,
  ensureContentMeta,
  markContentStep,
  resolveContentOutputDir,
  resolveContentRunDir,
  writeJson,
} from "../../lib/content/io.js";
import { researchTopics } from "../../lib/content/topics.js";
import { CONTENT_ARTIFACTS } from "../../lib/content/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isContentDryRun();
  const maxTopics = envInt("CONTENT_MAX_TOPICS", 8);
  const categories = contentCategories();
  const audiences = contentAudiences();
  const config = snapshotContentConfigFromEnv();
  const { runId, runDir } = resolveContentRunDir({ createIfMissing: true });
  ensureContentMeta(runDir, runId, config);

  const logPath = jobLogPath("content-research-topics");
  const writer = createJsonlLogger(logPath);

  const { topics, usedAi } = await researchTopics({
    maxTopics,
    categories,
    audiences,
  });

  writeJson(artifactPath(runDir, CONTENT_ARTIFACTS.topics), topics);

  const outDir = resolveContentOutputDir(runId);
  writeJson(path.join(outDir, "topics.json"), topics);

  markContentStep(runDir, "content-research-topics");

  writer.log({
    ts: new Date().toISOString(),
    type: "topics_complete",
    runId,
    count: topics.length,
    usedAi,
    dryRun,
  });
  await writer.close();

  console.log(
    `\nResearched ${topics.length} topics (${usedAi ? "AI" : "templates"}) → ${outDir}\\topics.json\n`,
  );
  for (const t of topics) {
    console.log(
      `  • [${t.interest ?? t.category}] ${t.title}`,
    );
  }

  if (topics.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No topics generated",
    };
  }

  return {
    exitCode: 0,
    message: `topics=${topics.length} source=${usedAi ? "ai" : "template"}`,
  };
}
