/**
 * Human-like visibility engagement: scroll content, score relevance,
 * like only when on-topic, comment only when score is high.
 * Dry-run: reactions allowed; comments typed but not sent.
 */

import type { Locator, Page } from "playwright";
import {
  SafetyLimitError,
  assertJobRuntime,
  assertWithinCap,
  humanDelay,
  recordAction,
  remainingCap,
} from "../linkedin-safety.js";
import { assertNotLogin } from "../leads/browser.js";
import { humanContentSearch } from "./search-ui.js";
import {
  scoreLeadFitForSoftwareDev,
  scorePostRelevance,
  shouldComment,
  shouldConnect,
  shouldLike,
} from "./relevance.js";
import { draftConnectNote, draftMeaningfulComment } from "./comments.js";
import type { EngagementRecord, FoundPost } from "./types.js";
import { normalizeUrl, postKey, slugId } from "./io.js";

export function draftCommentForPost(post: FoundPost): string {
  return draftMeaningfulComment(post);
}

async function findReactionButton(card: Locator): Promise<Locator | null> {
  const candidates = [
    card.locator('button[aria-label*="Like" i]').first(),
    card.locator('button[aria-label*="React" i]').first(),
    card.getByRole("button", { name: /^Like$/i }).first(),
  ];
  for (const loc of candidates) {
    if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) return loc;
  }
  return null;
}

async function findCommentOpener(card: Locator): Promise<Locator | null> {
  const candidates = [
    card.locator('button[aria-label*="Comment" i]').first(),
    card.getByRole("button", { name: /^Comment$/i }).first(),
  ];
  for (const loc of candidates) {
    if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) return loc;
  }
  return null;
}

async function findCommentEditor(
  page: Page,
  card: Locator,
): Promise<Locator | null> {
  const candidates = [
    card.locator('.ql-editor[contenteditable="true"]').first(),
    card.locator('[contenteditable="true"][role="textbox"]').first(),
    page.locator('.ql-editor[contenteditable="true"]').last(),
    page.locator('[contenteditable="true"][role="textbox"]').last(),
  ];
  for (const loc of candidates) {
    if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) return loc;
  }
  return null;
}

async function findCommentSubmit(
  page: Page,
  card: Locator,
): Promise<Locator | null> {
  const candidates = [
    card.getByRole("button", { name: /^Post$/i }).first(),
    card.getByRole("button", { name: /^Comment$/i }).last(),
    page.getByRole("button", { name: /^Post$/i }).last(),
  ];
  for (const loc of candidates) {
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) return loc;
  }
  return null;
}

type CardSnapshot = {
  key: string;
  url?: string;
  text: string;
  authorName?: string;
  authorProfileUrl?: string;
  index: number;
  /** LinkedIn urn / data attribute when available */
  urn?: string;
};

async function listVisibleCards(page: Page): Promise<CardSnapshot[]> {
  return (await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();

    function push(card, indexHint) {
      const text = (card.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length < 40) return;
      // Skip thin company/people stubs ("X · Follow") without real post body
      if (/\\bfollow\\b/i.test(text) && text.length < 90 && !/activity:/i.test(card.innerHTML || "")) {
        return;
      }
      let url = undefined;
      for (const a of Array.from(card.querySelectorAll("a[href]"))) {
        const href = a.href || "";
        if (/\\/feed\\/update|activity:|ugcPost:|share:/i.test(href)) {
          url = href.split("?")[0];
          break;
        }
      }
      // Prefer real activity posts; skip bare company /posts/ hubs
      if (url && /\\/company\\/[^/]+\\/posts\\/?$/i.test(url) && !/activity:/i.test(url)) {
        return;
      }
      if (!url) {
        for (const a of Array.from(card.querySelectorAll("a[href]"))) {
          const href = a.href || "";
          if (/\\/posts\\//i.test(href) && !/\\/company\\//i.test(href)) {
            url = href.split("?")[0];
            break;
          }
        }
      }
      let authorName = "";
      const actor = card.querySelector(
        ".update-components-actor__title span[aria-hidden='true'], .update-components-actor__name span[aria-hidden='true']",
      );
      if (actor) authorName = (actor.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100);
      let authorProfileUrl = undefined;
      for (const a of Array.from(card.querySelectorAll('a[href*="/in/"]'))) {
        const href = (a.href || "").split("?")[0].replace(/\\/$/, "");
        if (/linkedin\\.com\\/in\\/[^/]+$/i.test(href)) {
          authorProfileUrl = href;
          if (!authorName) {
            authorName = (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100);
          }
          break;
        }
      }
      const urn =
        card.getAttribute("data-urn") ||
        card.getAttribute("data-chameleon-result-urn") ||
        card.getAttribute("data-id") ||
        undefined;
      const key = (urn || url || text.slice(0, 100)).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        key,
        url,
        urn: urn || undefined,
        text: text.slice(0, 1200),
        authorName: authorName || undefined,
        authorProfileUrl: authorProfileUrl || undefined,
        index: typeof indexHint === "number" ? indexHint : out.length,
      });
    }

    const selectors = [
      ".feed-shared-update-v2",
      ".reusable-search__result-container",
      "li.reusable-search__result-container",
      "div[data-chameleon-result-urn]",
      "div[data-urn*='activity']",
      "div[data-view-name='feed-full-update']",
    ];
    let index = 0;
    for (const sel of selectors) {
      for (const card of Array.from(document.querySelectorAll(sel))) {
        push(card, index++);
        if (out.length >= 30) return out;
      }
    }

    // Fallback: climb from activity / post links (same as scrape)
    for (const a of Array.from(
      document.querySelectorAll(
        'a[href*="activity:"], a[href*="/posts/"], a[href*="/feed/update"]',
      ),
    )) {
      const card =
        a.closest(".feed-shared-update-v2") ||
        a.closest(".reusable-search__result-container") ||
        a.closest("li") ||
        a.closest("article") ||
        a.closest("div[data-chameleon-result-urn]") ||
        a.parentElement;
      if (card) push(card, index++);
      if (out.length >= 30) break;
    }
    return out;
  })()`)) as CardSnapshot[];
}

function toFoundPost(
  snap: CardSnapshot,
  keyword: string,
  now: string,
): FoundPost {
  const activity = snap.url?.match(/activity:(\d+)/i)?.[1];
  return {
    id: activity
      ? `vp-activity-${activity}`
      : slugId("vp", normalizeUrl(snap.url) || postKey({ url: snap.url, text: snap.text })),
    url: snap.url,
    authorName: snap.authorName,
    authorHeadline: undefined,
    text: snap.text,
    keyword,
    discoveredAt: now,
    authorProfileUrl: snap.authorProfileUrl,
  };
}

/** Resolve the Playwright locator for a scraped card (URN/id, not fragile nth index). */
async function resolveCardLocator(
  page: Page,
  snap: CardSnapshot,
): Promise<Locator | null> {
  const cardSel = [
    ".feed-shared-update-v2",
    ".reusable-search__result-container",
    "div[data-chameleon-result-urn]",
    "div[data-view-name='feed-full-update']",
    "div[data-urn]",
    "article",
    "li.artdeco-list__item",
  ].join(", ");

  const tryVisible = async (loc: Locator): Promise<Locator | null> => {
    const count = await loc.count().catch(() => 0);
    if (count < 1) return null;
    const first = loc.first();
    await first.scrollIntoViewIfNeeded().catch(() => undefined);
    const attached = await first
      .waitFor({ state: "attached", timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    return attached ? first : null;
  };

  if (snap.urn) {
    const escaped = snap.urn.replace(/"/g, "");
    const byUrn = await tryVisible(
      page.locator(
        `[data-urn="${escaped}"], [data-chameleon-result-urn="${escaped}"], [data-id="${escaped}"]`,
      ),
    );
    if (byUrn) return byUrn;
  }

  const idMatchers = [
    snap.url?.match(/activity:(\d+)/i)?.[1],
    snap.url?.match(/ugcPost:(\d+)/i)?.[1],
    snap.url?.match(/share:(\d+)/i)?.[1],
    snap.url?.match(/groupPost:([\d-]+)/i)?.[1],
    snap.url?.match(/(\d{15,})/)?.[1],
  ].filter(Boolean) as string[];

  for (const id of idMatchers) {
    // Prefer climbing from the post link itself (works even when card class differs)
    const link = page.locator(`a[href*="${id}"]`).first();
    if ((await link.count().catch(() => 0)) > 0) {
      await link.scrollIntoViewIfNeeded().catch(() => undefined);
      const byId = await tryVisible(
        page.locator(cardSel).filter({ has: page.locator(`a[href*="${id}"]`) }),
      );
      if (byId) return byId;
      // Use the link's nearest interactive ancestor as the "card"
      const ancestor = link.locator(
        "xpath=ancestor::div[contains(@class,'feed-shared-update') or contains(@class,'reusable-search') or @data-urn or @data-chameleon-result-urn][1]",
      );
      const anc = await tryVisible(ancestor);
      if (anc) return anc;
    }
  }

  if (snap.url) {
    const path = snap.url.replace(/^https?:\/\/(www\.)?linkedin\.com/i, "");
    const hrefPart = path.slice(0, 60).replace(/"/g, "");
    if (hrefPart.length > 12) {
      const byHref = await tryVisible(
        page.locator(cardSel).filter({
          has: page.locator(`a[href*="${hrefPart}"]`),
        }),
      );
      if (byHref) return byHref;
    }
  }

  return tryVisible(page.locator(cardSel).nth(snap.index));
}

/**
 * Last-resort like click via DOM walk from post id (when Playwright card locator misses).
 */
async function reactByPostIdFallback(
  page: Page,
  snap: CardSnapshot,
  dryRun: boolean,
): Promise<{ reacted: boolean; note: string } | null> {
  const id =
    snap.url?.match(/activity:(\d+)/i)?.[1] ||
    snap.url?.match(/ugcPost:(\d+)/i)?.[1] ||
    snap.url?.match(/share:(\d+)/i)?.[1] ||
    snap.url?.match(/groupPost:([\d-]+)/i)?.[1] ||
    snap.url?.match(/(\d{10,})/)?.[1];
  if (!id) return null;

  assertWithinCap("reaction");
  const result = await page.evaluate(`((id) => {
    const links = Array.from(document.querySelectorAll("a[href]")).filter((a) =>
      (a.getAttribute("href") || "").includes(id),
    );
    for (const a of links) {
      let el = a;
      for (let i = 0; i < 12 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const btn = el.querySelector(
          'button[aria-label*="Like" i], button[aria-label*="React" i], button[aria-label*="like" i]',
        );
        if (btn) {
          const pressed =
            btn.getAttribute("aria-pressed") === "true" ||
            /unlike|remove/i.test(btn.getAttribute("aria-label") || "");
          if (pressed) return "already_liked";
          btn.scrollIntoView({ block: "center", inline: "nearest" });
          btn.click();
          return "clicked";
        }
      }
    }
    return "not_found";
  })(${JSON.stringify(id)})`);

  if (result === "already_liked") {
    recordAction("reaction");
    return { reacted: true, note: "already_liked_fallback" };
  }
  if (result === "clicked") {
    await humanDelay("idle_micro");
    recordAction("reaction");
    return {
      reacted: true,
      note: dryRun ? "reacted_dry_run_allowed_fallback" : "reacted_fallback",
    };
  }
  return { reacted: false, note: `fallback_${result}` };
}

async function reactOnCard(
  card: Locator,
  dryRun: boolean,
): Promise<{ reacted: boolean; note: string }> {
  assertWithinCap("reaction");
  const likeBtn = await findReactionButton(card);
  if (!likeBtn) return { reacted: false, note: "like_button_missing" };

  const pressed =
    (await likeBtn.getAttribute("aria-pressed").catch(() => null)) === "true" ||
    /unlike|remove/i.test(
      (await likeBtn.getAttribute("aria-label").catch(() => "")) || "",
    );
  if (pressed) return { reacted: true, note: "already_liked" };

  await humanDelay("click");
  await likeBtn.click().catch(() => undefined);
  await humanDelay("idle_micro");
  recordAction("reaction");
  return {
    reacted: true,
    note: dryRun ? "reacted_dry_run_allowed" : "reacted",
  };
}

async function commentOnCard(
  page: Page,
  card: Locator,
  post: FoundPost,
  dryRun: boolean,
): Promise<{ drafted: boolean; sent: boolean; text?: string; notes: string[] }> {
  const notes: string[] = [];
  const commentText = draftCommentForPost(post);
  if (!commentText.trim()) {
    return {
      drafted: false,
      sent: false,
      notes: ["comment_skipped_thin_or_poll"],
    };
  }
  assertWithinCap("message");

  const opener = await findCommentOpener(card);
  if (opener) {
    await humanDelay("click");
    await opener.click().catch(() => undefined);
    await humanDelay("type_burst");
  }

  const editor = await findCommentEditor(page, card);
  if (!editor) {
    notes.push("comment_editor_missing");
    return { drafted: false, sent: false, text: commentText, notes };
  }

  await humanDelay("type_burst");
  await editor.click().catch(() => undefined);
  await editor.fill("").catch(() => undefined);
  await page.keyboard.type(commentText, { delay: 20 + Math.floor(Math.random() * 25) }).catch(
    async () => {
      await editor.fill(commentText).catch(() => undefined);
    },
  );
  await humanDelay("invite_think", { minMs: 900 });
  notes.push("comment_typed");

  if (dryRun) {
    notes.push("comment_not_sent_dry_run");
    return { drafted: true, sent: false, text: commentText, notes };
  }

  const submit = await findCommentSubmit(page, card);
  if (!submit) {
    notes.push("comment_submit_missing");
    return { drafted: true, sent: false, text: commentText, notes };
  }
  await humanDelay("click");
  await submit.click().catch(() => undefined);
  recordAction("message");
  notes.push("comment_sent");
  return { drafted: true, sent: true, text: commentText, notes };
}

export type ConnectCandidate = {
  profileUrl: string;
  authorName?: string;
  postId: string;
  leadFitScore: number;
  note: string;
};

export type ScrollEngageOptions = {
  keywords: string[];
  dryRun: boolean;
  delayMs: number;
  maxReactions: number;
  maxComments: number;
  /** Max cards to evaluate while scrolling */
  maxCardsToScan: number;
  likeMinScore: number;
  commentMinScore: number;
  /**
   * Queue author for connect when software-dev lead-fit is very high.
   * Does not open profiles during scroll — caller connects after.
   */
  connectMinLeadScore?: number;
  maxConnectCandidates?: number;
  /** Already-handled post ids */
  skipIds: Set<string>;
  /** Keyword label stored on FoundPost */
  activeKeyword?: string;
  /**
   * When true, do not navigate/search — continue on the current results page
   * (same browser session as a prior find/search).
   */
  continueOnCurrentPage?: boolean;
  onEngagement?: (record: EngagementRecord, post: FoundPost) => void;
};

export type ScrollEngageResult = {
  engagements: EngagementRecord[];
  postsSeen: FoundPost[];
  reactions: number;
  comments: number;
  skipped: number;
  connectCandidates: ConnectCandidate[];
};

/** Navigate via typed search (not deep-link SERP URLs). */
export async function openContentSearch(
  page: Page,
  keyword: string,
  delayMs: number,
): Promise<void> {
  await humanContentSearch(page, keyword, delayMs);
}

/**
 * Scroll the current page and selectively like/comment by relevance.
 * Does not open a new browser or perform a search unless continueOnCurrentPage=false
 * via scrollAndEngage().
 */
export async function engageWhileScrolling(
  page: Page,
  options: ScrollEngageOptions,
): Promise<ScrollEngageResult> {
  const engagements: EngagementRecord[] = [];
  const postsSeen: FoundPost[] = [];
  const connectCandidates: ConnectCandidate[] = [];
  const seenConnectUrls = new Set<string>();
  const seenKeys = new Set<string>();
  let reactions = 0;
  let comments = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  const reactBudget = Math.min(options.maxReactions, remainingCap("reaction"));
  const commentBudget = Math.min(options.maxComments, remainingCap("message"));
  const connectMin = options.connectMinLeadScore ?? 0;
  const maxConnectCand = options.maxConnectCandidates ?? 0;
  const keywords =
    options.keywords.length > 0 ? options.keywords : ["AI"];
  const activeKeyword = options.activeKeyword ?? keywords[0]!;

  let scans = 0;
  let idleRounds = 0;
  const maxIdleRounds = 10;

  while (
    scans < options.maxCardsToScan &&
    (reactions < reactBudget || comments < commentBudget) &&
    idleRounds < maxIdleRounds
  ) {
    assertJobRuntime();
    const cards = await listVisibleCards(page);
    let progressed = false;

    for (const snap of cards) {
      if (scans >= options.maxCardsToScan) break;
      if (seenKeys.has(snap.key)) continue;
      seenKeys.add(snap.key);
      scans += 1;
      progressed = true;

      const post = toFoundPost(snap, activeKeyword, now);
      if (options.skipIds.has(post.id)) {
        skipped += 1;
        continue;
      }
      postsSeen.push(post);

      const relevance = scorePostRelevance(post.text, keywords);
      const likeOk =
        shouldLike(relevance, options.likeMinScore) &&
        reactions < reactBudget;
      const commentOk =
        shouldComment(relevance, options.commentMinScore) &&
        comments < commentBudget;

      const readMs =
        relevance.score >= options.commentMinScore
          ? Math.min(options.delayMs + 2500, 8000)
          : relevance.score >= options.likeMinScore
            ? Math.min(options.delayMs + 1000, 5000)
            : Math.min(options.delayMs, 2800);
      await humanDelay("read_card", { minMs: readMs * 0.5, maxMs: readMs });

      const record: EngagementRecord = {
        postId: post.id,
        postUrl: post.url,
        reacted: false,
        commentDrafted: false,
        commentSent: false,
        dryRun: options.dryRun,
        relevanceScore: relevance.score,
        relevanceReasons: relevance.reasons,
        notes: [`topic:${relevance.topic ?? "none"}`],
      };

      if (!likeOk && !commentOk) {
        skipped += 1;
        record.notes!.push(
          `skipped_score_${relevance.score}_likeMin_${options.likeMinScore}_commentMin_${options.commentMinScore}`,
        );
        engagements.push(record);
        options.onEngagement?.(record, post);
        continue;
      }

      const card = await resolveCardLocator(page, snap);
      if (!card) {
        if (likeOk) {
          try {
            const fb = await reactByPostIdFallback(page, snap, options.dryRun);
            if (fb?.reacted) {
              record.reacted = true;
              record.reactionAt = new Date().toISOString();
              reactions += 1;
              record.notes!.push(fb.note);
              if (!commentOk) {
                record.notes!.push(
                  `no_comment_score_${relevance.score}`,
                );
                engagements.push(record);
                options.onEngagement?.(record, post);
                await humanDelay("between_companies", {
                  minMs: Math.min(options.delayMs, 2500),
                  maxMs: options.delayMs + 4000,
                });
                continue;
              }
              // comment still needs a card locator — fall through as skip for comment
              record.notes!.push("comment_skipped_no_card");
              engagements.push(record);
              options.onEngagement?.(record, post);
              continue;
            }
            record.notes!.push(fb?.note ?? "card_not_interactable");
          } catch (err) {
            if (err instanceof SafetyLimitError) throw err;
            record.notes!.push("react_fallback_error");
          }
        } else {
          record.notes!.push("card_not_interactable");
        }
        skipped += 1;
        engagements.push(record);
        options.onEngagement?.(record, post);
        continue;
      }

      await card.scrollIntoViewIfNeeded().catch(() => undefined);
      await humanDelay("idle_micro");

      if (likeOk) {
        try {
          let liked = false;
          let note = "";
          const r = await reactOnCard(card, options.dryRun);
          liked = r.reacted;
          note = r.note;
          if (!liked) {
            const fb = await reactByPostIdFallback(page, snap, options.dryRun);
            if (fb) {
              liked = fb.reacted;
              note = fb.note;
            }
          }
          record.reacted = liked;
          if (liked) {
            record.reactionAt = new Date().toISOString();
            reactions += 1;
          }
          record.notes!.push(note || "react_failed");
        } catch (err) {
          if (err instanceof SafetyLimitError) throw err;
          record.notes!.push("react_error");
        }
      } else {
        record.notes!.push(`no_like_score_${relevance.score}`);
      }

      if (commentOk) {
        try {
          const c = await commentOnCard(page, card, post, options.dryRun);
          record.commentDrafted = c.drafted;
          record.commentSent = c.sent;
          record.commentText = c.text;
          if (c.drafted) comments += 1;
          if (c.sent) record.commentAt = new Date().toISOString();
          record.notes!.push(...c.notes);
        } catch (err) {
          if (err instanceof SafetyLimitError) throw err;
          record.notes!.push("comment_error");
        }
      } else if (likeOk) {
        record.notes!.push(`no_comment_score_${relevance.score}`);
      }

      // Queue connect only for very strong software-dev lead-fit posts (not every author)
      if (
        connectMin > 0 &&
        maxConnectCand > 0 &&
        connectCandidates.length < maxConnectCand &&
        (record.reacted || record.commentDrafted || record.commentSent) &&
        post.authorProfileUrl
      ) {
        const leadFit = scoreLeadFitForSoftwareDev(post.text, {
          authorHeadline: post.authorHeadline,
        });
        record.leadFitScore = leadFit.score;
        if (shouldConnect(leadFit, connectMin)) {
          const urlKey = post.authorProfileUrl.toLowerCase();
          if (!seenConnectUrls.has(urlKey)) {
            seenConnectUrls.add(urlKey);
            connectCandidates.push({
              profileUrl: post.authorProfileUrl,
              authorName: post.authorName,
              postId: post.id,
              leadFitScore: leadFit.score,
              note: draftConnectNote({
                firstName: post.authorName?.split(/\s+/)[0],
                postHook: post.text.slice(0, 70),
              }),
            });
            record.notes!.push(`connect_queued_leadFit_${leadFit.score}`);
          }
        } else {
          record.notes!.push(`no_connect_leadFit_${leadFit.score}_min_${connectMin}`);
        }
      }

      engagements.push(record);
      options.onEngagement?.(record, post);

      await humanDelay("between_companies", {
        minMs: Math.min(options.delayMs, 2500),
        maxMs: options.delayMs + 4000,
      });

      if (reactions >= reactBudget && comments >= commentBudget) break;
    }

    const delta = progressed
      ? 700 + Math.floor(Math.random() * 900)
      : 1200 + Math.floor(Math.random() * 1400);
    await page.mouse.wheel(0, delta);
    await humanDelay("read_card", {
      minMs: progressed ? 800 : 1200,
      maxMs: progressed ? 2200 : 2800,
    });

    if (!progressed) idleRounds += 1;
    else idleRounds = 0;
  }

  return { engagements, postsSeen, reactions, comments, skipped, connectCandidates };
}

/**
 * Open content search (unless continueOnCurrentPage), then scroll/engage.
 */
export async function scrollAndEngage(
  page: Page,
  options: ScrollEngageOptions,
): Promise<ScrollEngageResult> {
  const keywords =
    options.keywords.length > 0 ? options.keywords : ["AI"];
  if (!options.continueOnCurrentPage) {
    await openContentSearch(page, keywords[0]!, options.delayMs);
  }
  return engageWhileScrolling(page, {
    ...options,
    activeKeyword: options.activeKeyword ?? keywords[0],
  });
}
