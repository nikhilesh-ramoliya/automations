/**
 * Type a LinkedIn share-box draft. Dry-run (default): never clicks Post.
 * Live publish only when CONTENT_DO_PUBLISH=true and not dry-run.
 */

import type { Locator, Page } from "playwright";
import { LINKEDIN_FEED_URL } from "../auth.js";
import { assertNotLogin } from "../leads/browser.js";
import {
  assertNoRestriction,
  humanDelay,
  recordAction,
} from "../linkedin-safety.js";
import {
  loadContentInstructions,
  validateAndRefineDraft,
} from "./instructions.js";
import { formatDraftForLinkedIn } from "./posts.js";
import { attachScore } from "./scoring.js";
import type { ContentDraft, ContentTopic } from "./types.js";

export type ComposeResult = {
  drafted: boolean;
  published: boolean;
  draftId: string;
  notes: string[];
  textPreview: string;
};

async function findStartPostTrigger(page: Page): Promise<Locator | null> {
  const candidates = [
    page.getByRole("button", { name: /start a post/i }),
    page.locator("button.share-box-feed-entry__trigger"),
    page.locator(".share-box-feed-entry__trigger"),
    page.locator('[data-control-name="share.share"]'),
    page.locator('button:has-text("Start a post")'),
  ];
  for (const loc of candidates) {
    const first = loc.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  return null;
}

async function findShareEditor(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator(".share-creation-state div.ql-editor[contenteditable='true']"),
    page.locator(".share-box div.ql-editor[contenteditable='true']"),
    page.locator("div.ql-editor[contenteditable='true']"),
    page.locator(
      '[data-placeholder*="What do you want to talk about"][contenteditable="true"]',
    ),
    page.locator(
      'div[role="textbox"][contenteditable="true"][aria-label*="Text editor" i]',
    ),
    page.locator('div[role="textbox"][contenteditable="true"]'),
  ];
  for (const loc of candidates) {
    const first = loc.first();
    if (await first.isVisible({ timeout: 2500 }).catch(() => false)) {
      return first;
    }
  }
  return null;
}

async function findPostButton(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator("button.share-actions__primary-action"),
    page.getByRole("button", { name: /^post$/i }),
    page.locator('button:has-text("Post")').filter({
      hasNotText: /repost|schedule/i,
    }),
  ];
  for (const loc of candidates) {
    const first = loc.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  return null;
}

async function typeIntoEditor(
  page: Page,
  editor: Locator,
  text: string,
): Promise<void> {
  await humanDelay("type_burst");
  await editor.click().catch(() => undefined);
  await humanDelay("idle_micro");

  // Clear any placeholder / leftover
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);

  // Human-ish typing; fall back to fill for long posts
  if (text.length <= 400) {
    await page.keyboard
      .type(text, { delay: 15 + Math.floor(Math.random() * 20) })
      .catch(async () => {
        await editor.fill(text).catch(() => undefined);
      });
  } else {
    await editor.fill(text).catch(async () => {
      await page.keyboard.type(text.slice(0, 500), { delay: 12 }).catch(
        () => undefined,
      );
    });
  }
  await humanDelay("invite_think", { minMs: 1200, maxMs: 2800 });
}

/**
 * Open feed → Start a post → type draft.
 * Never clicks Post when dryRun is true (or CONTENT_DO_PUBLISH is not enabled).
 * Re-validates against instructions.md and refines if Must/Never conflicts.
 */
export async function composeLinkedInDraft(
  page: Page,
  draft: ContentDraft,
  options: {
    dryRun: boolean;
    /** Hold the composer open so you can review (ms). Default 12s dry-run / 3s live. */
    reviewMs?: number;
    doPublish?: boolean;
    topic?: ContentTopic;
  },
): Promise<ComposeResult> {
  const notes: string[] = [];
  const instructions = loadContentInstructions();
  let working = draft;

  if (options.topic) {
    const refined = await validateAndRefineDraft({
      draft: working,
      topic: options.topic,
      instructions,
    });
    working = attachScore(
      {
        id: refined.draft.id,
        topicId: refined.draft.topicId,
        topic: refined.draft.topic,
        category: refined.draft.category,
        audience: refined.draft.audience,
        angle: refined.draft.angle,
        content: refined.draft.content,
        hashtags: refined.draft.hashtags,
        status: refined.draft.status,
        generatedAt: refined.draft.generatedAt,
        source: refined.draft.source,
        refined: refined.refined,
        instructionIssues: refined.draft.instructionIssues,
      },
      options.topic,
    );
    if (refined.refined) notes.push("refined_for_instructions");
    if (refined.issues.length) {
      notes.push(
        `instruction_warnings:${refined.issues.map((i) => i.detail).join(";")}`,
      );
    }
  }

  const text = formatDraftForLinkedIn(working);
  const preview = text.slice(0, 120).replace(/\n/g, " ");
  const allowPublish =
    !options.dryRun &&
    (options.doPublish === true ||
      process.env.CONTENT_DO_PUBLISH === "true" ||
      process.env.CONTENT_DO_PUBLISH === "1");

  await page.goto(LINKEDIN_FEED_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanDelay("nav", { minMs: 2000, maxMs: 4000 });
  assertNotLogin(page, "content-compose feed");
  assertNoRestriction(page.url(), "content-compose feed");

  const trigger = await findStartPostTrigger(page);
  if (!trigger) {
    notes.push("start_post_trigger_missing");
    return {
      drafted: false,
      published: false,
      draftId: working.id,
      notes,
      textPreview: preview,
    };
  }

  await humanDelay("click");
  await trigger.click();
  await humanDelay("type_burst", { minMs: 1500, maxMs: 3000 });
  notes.push("composer_opened");

  const editor = await findShareEditor(page);
  if (!editor) {
    notes.push("share_editor_missing");
    return {
      drafted: false,
      published: false,
      draftId: working.id,
      notes,
      textPreview: preview,
    };
  }

  await typeIntoEditor(page, editor, text);
  notes.push("post_typed");
  // Count as a page view / light action for safety pacing (not a published post)
  recordAction("page_view");

  if (!allowPublish) {
    notes.push(
      options.dryRun
        ? "post_not_published_dry_run"
        : "post_not_published_CONTENT_DO_PUBLISH_required",
    );
    const reviewMs =
      options.reviewMs ?? (options.dryRun ? 12_000 : 4_000);
    console.log(
      `\n[content-compose] Draft typed into LinkedIn. Post button NOT clicked.` +
        ` Review for ~${Math.round(reviewMs / 1000)}s, then closing.\n`,
    );
    await humanDelay("invite_think", {
      minMs: reviewMs,
      maxMs: reviewMs + 2000,
    });
    // Dismiss without posting (Escape / discard)
    await page.keyboard.press("Escape").catch(() => undefined);
    await humanDelay("idle_micro");
    const discard = page.getByRole("button", { name: /discard|delete/i }).first();
    if (await discard.isVisible().catch(() => false)) {
      await discard.click().catch(() => undefined);
      await humanDelay("idle_micro");
      const confirm = page.getByRole("button", { name: /discard|confirm|delete/i }).last();
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click().catch(() => undefined);
      }
      notes.push("composer_discarded");
    } else {
      notes.push("composer_left_or_escaped");
    }
    return {
      drafted: true,
      published: false,
      draftId: working.id,
      notes,
      textPreview: preview,
    };
  }

  const postBtn = await findPostButton(page);
  if (!postBtn) {
    notes.push("post_button_missing");
    return {
      drafted: true,
      published: false,
      draftId: working.id,
      notes,
      textPreview: preview,
    };
  }
  await humanDelay("click");
  await postBtn.click();
  await humanDelay("invite_think", { minMs: 2000, maxMs: 4000 });
  notes.push("post_published");
  return {
    drafted: true,
    published: true,
    draftId: working.id,
    notes,
    textPreview: preview,
  };
}

/** Pick highest-scoring draft, optionally filtered. */
export function pickDraftToCompose(
  drafts: ContentDraft[],
  opts?: { minScore?: number; draftId?: string },
): ContentDraft | undefined {
  if (opts?.draftId) {
    return drafts.find((d) => d.id === opts.draftId);
  }
  const pool = drafts
    .filter((d) => d.status === "draft" || d.status === "reviewed")
    .filter((d) =>
      opts?.minScore === undefined ? true : d.score >= opts.minScore,
    )
    .sort((a, b) => b.score - a.score);
  return pool[0];
}
