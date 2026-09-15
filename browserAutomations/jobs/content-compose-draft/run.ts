import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  composeLinkedInDraft,
  pickDraftToCompose,
} from "../../lib/content/compose.js";
import {
  contentAttachImage,
  envBool,
  envInt,
  isContentDryRun,
  snapshotContentConfigFromEnv,
} from "../../lib/content/env.js";
import { defaultCardPath, renderDraftCard } from "../../lib/content/image-card.js";
import {
  artifactPath,
  ensureContentMeta,
  loadDrafts,
  markContentStep,
  resolveContentRunDir,
  writeJson,
} from "../../lib/content/io.js";
import { hasLinkedInAuth, withLinkedInPage } from "../../lib/leads/browser.js";
import { CONTENT_ARTIFACTS } from "../../lib/content/types.js";

export async function run(): Promise<JobRunResult> {
  const dryRun = isContentDryRun();
  const minScore = envInt("CONTENT_MIN_SCORE", 55);
  const reviewMs = envInt("CONTENT_COMPOSE_REVIEW_MS", 12_000);
  const draftId = process.env.CONTENT_COMPOSE_DRAFT_ID?.trim();
  const doPublish = envBool("CONTENT_DO_PUBLISH", false);
  const config = snapshotContentConfigFromEnv();
  const { runId, runDir } = resolveContentRunDir({ createIfMissing: false });
  ensureContentMeta(runDir, runId, config);

  const logPath = jobLogPath("content-compose-draft");
  const writer = createJsonlLogger(logPath);

  if (!hasLinkedInAuth()) {
    await writer.close();
    return {
      exitCode: 1,
      message: "Not authenticated. Run `npm run auth:linkedin`.",
    };
  }

  const drafts = loadDrafts(runDir);
  if (drafts.length === 0) {
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message:
        "No drafts.json. Run content-pipeline / content-generate-posts first.",
    };
  }

  const draft = pickDraftToCompose(drafts, { minScore, draftId });
  if (!draft) {
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: draftId
        ? `Draft id not found: ${draftId}`
        : `No draft with score ≥ ${minScore}`,
    };
  }

  console.log(
    `\nComposing draft ${draft.id} (score=${draft.score}, angle=${draft.angle})` +
      `\nDry-run=${dryRun} → Post button will ${
        dryRun || !doPublish ? "NOT" : ""
      } be clicked.\n`,
  );

  let imagePath = process.env.CONTENT_IMAGE_PATH?.trim();
  if (contentAttachImage() && !imagePath) {
    try {
      imagePath = defaultCardPath(runDir, draft.id);
      await renderDraftCard(draft, imagePath);
      draft.imagePath = imagePath;
      writeJson(
        artifactPath(runDir, CONTENT_ARTIFACTS.drafts),
        drafts.map((d) => (d.id === draft.id ? { ...d, imagePath } : d)),
      );
      console.log(`[content-compose] Generated title card:\n  ${imagePath}\n`);
    } catch (err) {
      console.warn(
        `[content-compose] Card render failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      imagePath = undefined;
    }
  } else if (imagePath) {
    console.log(`[content-compose] Using image:\n  ${imagePath}\n`);
  } else {
    console.log("[content-compose] Image attach disabled or no path.\n");
  }

  const result = await withLinkedInPage(
    async (page) =>
      composeLinkedInDraft(page, draft, {
        dryRun,
        reviewMs,
        doPublish,
        runDir,
        imagePath,
        topic: {
          id: draft.topicId,
          title: draft.topic,
          summary: draft.topic,
          category: draft.category,
          targetAudience: draft.audience,
          reason: "",
          suggestedAngle: String(draft.angle),
          researchedAt: draft.generatedAt,
          source: draft.source,
        },
      }),
    { jobId: "content-compose-draft" },
  );

  const composeLog = {
    at: new Date().toISOString(),
    dryRun,
    ...result,
    topic: draft.topic,
    score: draft.score,
  };
  writeJson(path.join(runDir, "compose.json"), composeLog);
  writeJson(
    artifactPath(runDir, CONTENT_ARTIFACTS.drafts),
    drafts.map((d) => {
      if (d.id !== draft.id) return d;
      return {
        ...d,
        ...(result.published ? { status: "published" as const } : {}),
        ...(result.imagePath ? { imagePath: result.imagePath } : {}),
      };
    }),
  );

  markContentStep(runDir, "content-compose-draft");
  writer.log({
    ts: new Date().toISOString(),
    type: "compose_complete",
    runId,
    ...result,
  });
  await writer.close();

  if (!result.drafted) {
    return {
      exitCode: 1,
      message: `Compose failed: ${result.notes.join(", ")}`,
    };
  }

  return {
    exitCode: 0,
    message: result.published
      ? `published draft=${draft.id}`
      : `typed_not_posted draft=${draft.id} notes=${result.notes.join("|")}`,
  };
}
