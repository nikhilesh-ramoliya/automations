/** Deterministic quality scoring for LinkedIn content drafts. */

import { contentBrandName } from "./env.js";
import { forbidsBrandMention } from "./instructions.js";
import { listInterests, matchInterest } from "./interests.js";
import type { ContentDraft, ContentScoreBreakdown, ContentTopic } from "./types.js";

const FILLER =
  /\b(in today's fast-paced|game[- ]changer|leverage synerg|unlock the power|revolutionize|cutting[- ]edge solutions|dive deep|at the end of the day)\b/i;

const HOOK_WEAK =
  /^(i'?m excited to|thrilled to announce|in this post i will|hello (everyone|network)|as we all know)/i;

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasDiscussionQuestion(text: string): boolean {
  const lines = text.trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-3).join(" ");
  return /\?/.test(tail);
}

function paragraphCount(text: string): number {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean).length;
}

/**
 * Score a draft 0–100 across originality, readability, engagement,
 * technical accuracy (heuristic), relevance, and brand alignment.
 */
export function scoreContentDraft(input: {
  content: string;
  hashtags: string[];
  topic: ContentTopic;
  angle: string;
}): ContentScoreBreakdown {
  const body = input.content.trim();
  const words = wordCount(body);
  const brand = contentBrandName().toLowerCase();
  const lower = body.toLowerCase();
  const noBrand = forbidsBrandMention();

  let originality = 72;
  if (FILLER.test(body)) originality -= 25;
  if (HOOK_WEAK.test(body)) originality -= 15;
  if (/\b(synergy|paradigm shift|disrupt)\b/i.test(body)) originality -= 10;
  if (body.split(/[.!?]/).length >= 4) originality += 5;

  let readability = 60;
  if (words >= 150 && words <= 300) readability += 25;
  else if (words >= 120 && words <= 350) readability += 12;
  else if (words < 100 || words > 400) readability -= 20;
  const paras = paragraphCount(body);
  if (paras >= 3 && paras <= 8) readability += 10;
  if (body.includes("\n")) readability += 5;

  let engagement = 50;
  const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
  if (firstLine.length >= 20 && firstLine.length <= 160) engagement += 15;
  if (!HOOK_WEAK.test(firstLine)) engagement += 10;
  if (hasDiscussionQuestion(body)) engagement += 15;
  const tagCount = input.hashtags.filter(Boolean).length;
  if (tagCount >= 3 && tagCount <= 5) engagement += 10;
  else if (tagCount > 0) engagement += 4;
  const emojiCount = (body.match(/[\u{1F300}-\u{1FAFF}]/gu) ?? []).length;
  if (emojiCount === 0) engagement += 5;
  else if (emojiCount > 3) engagement -= 15;

  let technical = 55;
  const concrete =
    /\b(\d+|checklist|runbook|rollback|latency|selector|CI|MVP|SLA|ownership|exception|metric|observability|contract test)\b/i;
  if (concrete.test(body)) technical += 20;
  if (
    /\b(always|never|guaranteed|100%)\b/i.test(body) &&
    !/\b(almost never|almost always)\b/i.test(body)
  ) {
    technical -= 8;
  }
  if (input.angle === "technical_lesson" || input.angle === "educational") {
    technical += 5;
  }

  let relevance = 50;
  const topicTokens = `${input.topic.title} ${input.topic.category} ${input.topic.targetAudience}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
  const hits = topicTokens.filter((t) => lower.includes(t)).length;
  relevance += Math.min(35, hits * 5);
  if (lower.includes(input.topic.category.toLowerCase().split(/\s+/)[0] ?? "")) {
    relevance += 8;
  }

  // Soft boost/penalty for personal Interests alignment
  const interests = listInterests();
  if (interests.length) {
    const assigned =
      input.topic.interest ??
      matchInterest(
        `${input.topic.title} ${input.topic.summary} ${input.topic.category}`,
        interests,
      );
    const bodyMatch = matchInterest(
      `${assigned ?? ""} ${body} ${input.hashtags.join(" ")}`,
      interests,
    );
    if (assigned && bodyMatch) {
      const same =
        assigned.toLowerCase() === bodyMatch.toLowerCase() ||
        lower.includes(assigned.toLowerCase());
      relevance += same ? 12 : 6;
    } else if (assigned && !bodyMatch) {
      relevance -= 10;
    } else if (!assigned) {
      relevance -= 8;
    }
  }

  let brandAlignment = 70;
  const brandHits = lower.split(brand).length - 1;
  if (noBrand) {
    if (brandHits === 0) brandAlignment += 20;
    else brandAlignment -= 40 * brandHits;
  } else {
    if (brandHits === 1) brandAlignment += 10;
    if (brandHits > 2) brandAlignment -= 20;
    if (/\b(we help|in our (experience|delivery|client work)|partner)\b/i.test(body)) {
      brandAlignment += 5;
    }
  }
  if (
    /\b(book a (demo|call)|limited time|dm me for pricing|click the link)\b/i.test(
      body,
    )
  ) {
    brandAlignment -= 35;
  }
  if (hasDiscussionQuestion(body)) brandAlignment += 5;

  const originalityC = clamp(originality);
  const readabilityC = clamp(readability);
  const engagementC = clamp(engagement);
  const technicalC = clamp(technical);
  const relevanceC = clamp(relevance);
  const brandC = clamp(brandAlignment);

  const total = clamp(
    originalityC * 0.15 +
      readabilityC * 0.2 +
      engagementC * 0.2 +
      technicalC * 0.15 +
      relevanceC * 0.15 +
      brandC * 0.15,
  );

  return {
    originality: originalityC,
    readability: readabilityC,
    engagementPotential: engagementC,
    technicalAccuracy: technicalC,
    relevance: relevanceC,
    brandAlignment: brandC,
    total,
  };
}

export function attachScore(
  draft: Omit<ContentDraft, "score" | "scoreBreakdown">,
  topic: ContentTopic,
): ContentDraft {
  const breakdown = scoreContentDraft({
    content: draft.content,
    hashtags: draft.hashtags,
    topic,
    angle: String(draft.angle),
  });
  return {
    ...draft,
    score: breakdown.total,
    scoreBreakdown: breakdown,
  };
}
