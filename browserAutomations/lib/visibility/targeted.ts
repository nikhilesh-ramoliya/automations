/**
 * Targeted visibility: search ICP people → view profiles → engage their posts
 * (meaningful comments + selective reacts) → optional personalized connects.
 *
 * Favors intentional prospecting over keyword content SERP scrolling.
 */

import type { Page } from "playwright";
import { humanScroll } from "../human-browse.js";
import { assertNotLogin } from "../leads/browser.js";
import { connectWithOptionalNote } from "../leads/linkedin-connect.js";
import {
  SafetyLimitError,
  assertJobRuntime,
  assertWithinCap,
  humanDelay,
  recordAction,
  remainingCap,
} from "../linkedin-safety.js";
import { draftConnectNote } from "./comments.js";
import { engageWhileScrolling } from "./engage.js";
import { normalizeUrl, slugId } from "./io.js";
import {
  humanPeopleSearch,
  scrapePeopleFromSerp,
} from "./people-search-ui.js";
import type {
  EngagementRecord,
  FoundPost,
  TargetPerson,
} from "./types.js";

export type TargetedEngageOptions = {
  queries: string[];
  dryRun: boolean;
  delayMs: number;
  maxProfiles: number;
  maxReactions: number;
  maxComments: number;
  maxConnects: number;
  /** Max cards to scan per person's activity */
  maxCardsPerProfile: number;
  likeMinScore: number;
  commentMinScore: number;
  doReact: boolean;
  doComment: boolean;
  doConnect: boolean;
  skipProfileUrls: Set<string>;
  skipPostIds: Set<string>;
  onTarget?: (t: TargetPerson) => void;
  onEngagement?: (e: EngagementRecord, post: FoundPost) => void;
  onPosts?: (posts: FoundPost[]) => void;
};

export type TargetedEngageResult = {
  targets: TargetPerson[];
  posts: FoundPost[];
  engagements: EngagementRecord[];
  profilesViewed: number;
  reactions: number;
  comments: number;
  connects: number;
  skipped: number;
};

async function openPersonActivity(
  page: Page,
  profileUrl: string,
): Promise<void> {
  const base = profileUrl.replace(/\/$/, "");
  const activityUrl = `${base}/recent-activity/all/`;
  assertWithinCap("page_view");
  await page.goto(activityUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanDelay("nav", { minMs: 1500, maxMs: 3500 });
  assertNotLogin(page, "person recent activity");
  recordAction("page_view");

  const hasCards = await page
    .locator(
      ".feed-shared-update-v2, a[href*='activity:'], a[href*='ugcPost:'], a[href*='share:']",
    )
    .count()
    .catch(() => 0);
  if (hasCards < 1) {
    const postsUrl = `${base}/recent-activity/shares/`;
    await page
      .goto(postsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      })
      .catch(() => undefined);
    await humanDelay("nav", { minMs: 1200, maxMs: 2800 });
  }
}

/** Light profile dwell for volume ICP passes. */
async function glanceProfile(page: Page, profileUrl: string): Promise<void> {
  assertWithinCap("profile_view");
  await page.goto(profileUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanDelay("nav");
  assertNotLogin(page, "target profile");
  await humanScroll(page, { passes: 2, allowUp: true });
  await humanDelay("read_card", { minMs: 5000, maxMs: 14_000 });
  recordAction("profile_view");
}

export async function runTargetedEngage(
  page: Page,
  options: TargetedEngageOptions,
): Promise<TargetedEngageResult> {
  const targets: TargetPerson[] = [];
  const posts: FoundPost[] = [];
  const engagements: EngagementRecord[] = [];
  let profilesViewed = 0;
  let reactions = 0;
  let comments = 0;
  let connects = 0;
  let skipped = 0;

  let reactLeft = Math.min(options.maxReactions, remainingCap("reaction"));
  let commentLeft = Math.min(options.maxComments, remainingCap("message"));
  let connectLeft = Math.min(options.maxConnects, remainingCap("connect"));
  const skipProfiles = new Set(
    [...options.skipProfileUrls].map((u) => normalizeUrl(u) || u),
  );
  const skipPosts = new Set(options.skipPostIds);
  const seenProfiles = new Set<string>();
  const peopleBudget = options.maxProfiles;

  for (const query of options.queries) {
    if (profilesViewed >= peopleBudget) break;
    if (
      reactLeft <= 0 &&
      commentLeft <= 0 &&
      (!options.doConnect || connectLeft <= 0)
    ) {
      break;
    }

    assertJobRuntime();
    console.log(`\n  ICP search: “${query}”`);
    await humanPeopleSearch(page, query, options.delayMs);

    const cards = await scrapePeopleFromSerp(
      page,
      Math.min(25, peopleBudget * 2),
    );
    console.log(`  People cards: ${cards.length}`);

    for (const card of cards) {
      if (profilesViewed >= peopleBudget) break;
      if (
        reactLeft <= 0 &&
        commentLeft <= 0 &&
        (!options.doConnect || connectLeft <= 0)
      ) {
        break;
      }

      const urlKey =
        normalizeUrl(card.profileUrl) || card.profileUrl.toLowerCase();
      if (seenProfiles.has(urlKey) || skipProfiles.has(urlKey)) continue;
      seenProfiles.add(urlKey);

      const person: TargetPerson = {
        id: slugId("tp", card.profileUrl),
        name: card.name,
        title: card.title,
        profileUrl: card.profileUrl,
        location: card.location,
        query,
        discoveredAt: new Date().toISOString(),
        notes: [],
      };

      try {
        console.log(
          `  → ${person.name}${person.title ? ` · ${person.title}` : ""}`,
        );
        await glanceProfile(page, person.profileUrl);
        person.profileViewed = true;
        profilesViewed += 1;
        options.onTarget?.(person);

        await openPersonActivity(page, person.profileUrl);
        await humanScroll(page, { passes: 2 });

        const perReact = options.doReact ? Math.min(2, reactLeft) : 0;
        const perComment = options.doComment ? Math.min(2, commentLeft) : 0;

        if (perReact > 0 || perComment > 0) {
          const result = await engageWhileScrolling(page, {
            keywords: [
              query,
              "software",
              "engineering",
              "AI",
              "automation",
              "consulting",
            ],
            activeKeyword: query,
            dryRun: options.dryRun,
            delayMs: options.delayMs,
            maxReactions: perReact,
            maxComments: perComment,
            maxCardsToScan: options.maxCardsPerProfile,
            likeMinScore: options.likeMinScore,
            commentMinScore: Math.min(
              options.commentMinScore,
              Math.max(55, options.commentMinScore - 10),
            ),
            skipIds: skipPosts,
            continueOnCurrentPage: true,
            onEngagement: (record, post) => {
              record.targetPersonId = person.id;
              record.targetName = person.name;
              skipPosts.add(record.postId);
              engagements.push(record);
              if (!posts.find((x) => x.id === post.id)) posts.push(post);
              options.onEngagement?.(record, post);
              options.onPosts?.([post]);
            },
          });

          reactions += result.reactions;
          comments += result.comments;
          skipped += result.skipped;
          reactLeft = Math.max(0, reactLeft - result.reactions);
          commentLeft = Math.max(0, commentLeft - result.comments);
          for (const p of result.postsSeen) {
            if (!posts.find((x) => x.id === p.id)) posts.push(p);
          }
        }

        const engagedThisPerson = engagements.some(
          (e) =>
            e.targetPersonId === person.id &&
            (e.reacted || e.commentDrafted || e.commentSent),
        );

        if (
          options.doConnect &&
          connectLeft > 0 &&
          (engagedThisPerson || Math.random() < 0.25)
        ) {
          const hookPost = engagements
            .filter((e) => e.targetPersonId === person.id && e.commentText)
            .at(-1);
          const note = draftConnectNote({
            firstName: person.name.split(/\s+/)[0],
            title: person.title,
            postHook: hookPost?.commentText?.slice(0, 60),
          });

          const conn = await connectWithOptionalNote(page, {
            profileUrl: person.profileUrl,
            note,
            dryRun: options.dryRun,
            addNote: true,
          });
          if (conn.ok) {
            person.connected =
              conn.mode === "connected" ||
              conn.mode === "note_sent" ||
              conn.mode === "dry_run";
            person.connectMode = conn.mode;
            if (
              conn.mode === "connected" ||
              conn.mode === "note_sent" ||
              conn.mode === "dry_run"
            ) {
              connects += 1;
              connectLeft = Math.max(0, connectLeft - 1);
            }
            person.notes!.push(`connect:${conn.mode}`);
          } else {
            person.notes!.push(`connect_fail:${conn.error}`);
          }
        }

        targets.push(person);
        options.onTarget?.(person);

        await humanDelay("between_companies", {
          minMs: Math.min(options.delayMs, 2500),
          maxMs: options.delayMs + 5000,
        });
      } catch (err) {
        if (err instanceof SafetyLimitError) throw err;
        person.notes!.push(
          `error:${err instanceof Error ? err.message.slice(0, 80) : "unknown"}`,
        );
        targets.push(person);
        options.onTarget?.(person);
      }
    }
  }

  return {
    targets,
    posts,
    engagements,
    profilesViewed,
    reactions,
    comments,
    connects,
    skipped,
  };
}
