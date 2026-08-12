/**
 * Single-browser LinkedIn visibility workflow (find + engage in one session).
 * Content-first: type search → scroll posts → like/comment inline.
 * Connect only when a post is a strong software-dev lead fit (after engage pass).
 */

import type { Page } from "playwright";
import { connectWithOptionalNote } from "../leads/linkedin-connect.js";
import { humanDelay, remainingCap } from "../linkedin-safety.js";
import {
  engageWhileScrolling,
  openContentSearch,
  scrollAndEngage,
  type ConnectCandidate,
} from "./engage.js";
import { findRelatedPosts } from "./posts.js";
import type { EngagementRecord, FoundPost } from "./types.js";

export type VisibilitySessionOptions = {
  keywords: string[];
  delayMs: number;
  dryRun: boolean;
  doFind: boolean;
  doEngage: boolean;
  maxPosts: number;
  maxReactions: number;
  maxComments: number;
  maxCardsToScan: number;
  likeMinScore: number;
  commentMinScore: number;
  /** Connect only if software-dev lead-fit ≥ this (0 = never) */
  connectMinLeadScore?: number;
  maxConnects?: number;
  skipEngagementIds: Set<string>;
  onPosts?: (posts: FoundPost[], keyword: string) => void;
  onEngagement?: (record: EngagementRecord, post: FoundPost) => void;
};

export type VisibilitySessionResult = {
  posts: FoundPost[];
  engagements: EngagementRecord[];
  reactions: number;
  comments: number;
  skipped: number;
  connects: number;
};

function mergeById(existing: FoundPost[], incoming: FoundPost[]): FoundPost[] {
  const map = new Map(existing.map((p) => [p.id, p]));
  for (const p of incoming) map.set(p.id, p);
  return [...map.values()];
}

async function sendQueuedConnects(
  page: Page,
  candidates: ConnectCandidate[],
  opts: {
    dryRun: boolean;
    maxConnects: number;
    engagements: EngagementRecord[];
  },
): Promise<number> {
  let connects = 0;
  let left = Math.min(opts.maxConnects, remainingCap("connect"));
  for (const c of candidates) {
    if (left <= 0) break;
    console.log(
      `  Connect (leadFit=${c.leadFitScore}): ${c.authorName ?? c.profileUrl}`,
    );
    const result = await connectWithOptionalNote(page, {
      profileUrl: c.profileUrl,
      note: c.note,
      dryRun: opts.dryRun,
      addNote: true,
    });
    const eng = opts.engagements.find((e) => e.postId === c.postId);
    if (eng) {
      eng.connectAttempted = true;
      eng.connectMode = result.ok ? result.mode : result.error;
      eng.notes = eng.notes ?? [];
      eng.notes.push(
        result.ok ? `connect:${result.mode}` : `connect_fail:${result.error}`,
      );
    }
    if (
      result.ok &&
      (result.mode === "connected" ||
        result.mode === "note_sent" ||
        result.mode === "dry_run")
    ) {
      connects += 1;
      left -= 1;
    }
    await humanDelay("between_companies", { minMs: 2000, maxMs: 5000 });
  }
  return connects;
}

/**
 * Run find and/or engage on one Playwright page (one LinkedIn profile session).
 *
 * Find+engage together: one typed search per keyword, then a single scroll pass
 * that both collects posts and selectively engages — no second navigation.
 * High lead-fit authors may be queued for connect after the scroll pass.
 */
export async function runVisibilityLinkedInSession(
  page: Page,
  options: VisibilitySessionOptions,
): Promise<VisibilitySessionResult> {
  const keywords = options.keywords.length > 0 ? options.keywords : ["AI"];
  let posts: FoundPost[] = [];
  let engagements: EngagementRecord[] = [];
  let reactions = 0;
  let comments = 0;
  let skipped = 0;
  let connects = 0;
  const skipIds = new Set(options.skipEngagementIds);
  const allConnectCandidates: ConnectCandidate[] = [];
  const connectMin = options.connectMinLeadScore ?? 0;
  const maxConnects = options.maxConnects ?? 0;

  // Engage only
  if (!options.doFind && options.doEngage) {
    const result = await scrollAndEngage(page, {
      keywords,
      dryRun: options.dryRun,
      delayMs: options.delayMs,
      maxReactions: options.maxReactions,
      maxComments: options.maxComments,
      maxCardsToScan: options.maxCardsToScan,
      likeMinScore: options.likeMinScore,
      commentMinScore: options.commentMinScore,
      connectMinLeadScore: connectMin,
      maxConnectCandidates: maxConnects,
      skipIds,
      onEngagement: options.onEngagement,
    });
    if (maxConnects > 0 && result.connectCandidates.length) {
      connects = await sendQueuedConnects(page, result.connectCandidates, {
        dryRun: options.dryRun,
        maxConnects,
        engagements: result.engagements,
      });
    }
    return {
      posts: result.postsSeen,
      engagements: result.engagements,
      reactions: result.reactions,
      comments: result.comments,
      skipped: result.skipped,
      connects,
    };
  }

  // Find only
  if (options.doFind && !options.doEngage) {
    posts = await findRelatedPosts(page, keywords, {
      maxPosts: options.maxPosts,
      delayMs: options.delayMs,
    });
    options.onPosts?.(posts, keywords.join("|"));
    return { posts, engagements, reactions, comments, skipped, connects };
  }

  // Find + engage: typed search once per keyword, then one scroll/engage pass
  let reactLeft = options.maxReactions;
  let commentLeft = options.maxComments;
  let scanLeft = options.maxCardsToScan;

  for (const keyword of keywords) {
    if (
      posts.length >= options.maxPosts &&
      reactLeft <= 0 &&
      commentLeft <= 0
    ) {
      break;
    }
    if (scanLeft <= 0) break;

    await openContentSearch(page, keyword, options.delayMs);

    const result = await engageWhileScrolling(page, {
      keywords,
      activeKeyword: keyword,
      dryRun: options.dryRun,
      delayMs: options.delayMs,
      maxReactions: reactLeft,
      maxComments: commentLeft,
      maxCardsToScan: Math.min(
        scanLeft,
        options.maxPosts - posts.length || scanLeft,
      ),
      likeMinScore: options.likeMinScore,
      commentMinScore: options.commentMinScore,
      connectMinLeadScore: connectMin,
      maxConnectCandidates: Math.max(
        0,
        maxConnects - allConnectCandidates.length,
      ),
      skipIds,
      continueOnCurrentPage: true,
      onEngagement: (record, post) => {
        skipIds.add(record.postId);
        options.onEngagement?.(record, post);
      },
    });

    posts = mergeById(posts, result.postsSeen);
    options.onPosts?.(result.postsSeen, keyword);
    engagements = [...engagements, ...result.engagements];
    reactions += result.reactions;
    comments += result.comments;
    skipped += result.skipped;
    for (const c of result.connectCandidates) {
      if (
        !allConnectCandidates.some(
          (x) => x.profileUrl.toLowerCase() === c.profileUrl.toLowerCase(),
        )
      ) {
        allConnectCandidates.push(c);
      }
    }
    reactLeft = Math.max(0, reactLeft - result.reactions);
    commentLeft = Math.max(0, commentLeft - result.comments);
    scanLeft = Math.max(0, scanLeft - result.postsSeen.length);

    await humanDelay("between_companies", {
      minMs: Math.min(options.delayMs, 3000),
    });
  }

  if (maxConnects > 0 && allConnectCandidates.length) {
    connects = await sendQueuedConnects(
      page,
      allConnectCandidates.slice(0, maxConnects),
      {
        dryRun: options.dryRun,
        maxConnects,
        engagements,
      },
    );
  }

  return { posts, engagements, reactions, comments, skipped, connects };
}
