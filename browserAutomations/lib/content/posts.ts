/** Generate LinkedIn post drafts via Cursor Agent (no template angle conditionals). */

import { isCursorAvailable, cursorPromptJson } from "../ai/cursor-agent.js";
import {
  chatCompletion,
  isAiAvailable,
  parseJsonObject,
} from "../ai/client.js";
import { contentUseAi } from "./env.js";
import {
  forbidsBrandMention,
  loadContentInstructions,
  validateAndRefineDraft,
} from "./instructions.js";
import { slugId } from "./io.js";
import {
  generatePostsSystemPrompt,
  generatePostsUserPrompt,
} from "./prompts.js";
import { attachScore } from "./scoring.js";
import type { ContentDraft, ContentTopic, PostAngle } from "./types.js";
import { POST_ANGLES } from "./types.js";
import {
  dedupeDrafts,
  recordPublishedOrDrafted,
} from "./uniqueness.js";
import {
  matchInterest,
  recordInterestUse,
  resolveInterestLabel,
  listInterests,
} from "./interests.js";

function hashtagsFor(category: string): string[] {
  const c = category.toLowerCase();
  if (c.includes("ai")) return ["AI", "GenAI", "EngineeringLeadership"];
  if (c.includes("automat")) return ["Automation", "OpsExcellence", "Productivity"];
  if (c.includes("playwright") || c.includes("test"))
    return ["Playwright", "QualityEngineering", "Testing"];
  if (c.includes("cloud") || c.includes("devops"))
    return ["Cloud", "DevOps", "SRE"];
  if (c.includes("mvp") || c.includes("startup") || c.includes("saas"))
    return ["Startups", "SaaS", "ProductDevelopment"];
  if (c.includes("architect") || c.includes("performance"))
    return ["SoftwareArchitecture", "Performance", "Engineering"];
  if (c.includes("lead") || c.includes("scal") || c.includes("product"))
    return ["EngineeringLeadership", "ProductDevelopment", "TechManagement"];
  return ["SoftwareEngineering", "TechLeadership", "BuildInPublic"];
}

function pickAngles(count: number, preferred?: string): PostAngle[] {
  const start = POST_ANGLES.includes(preferred as PostAngle)
    ? (preferred as PostAngle)
    : POST_ANGLES[Math.floor(Math.random() * POST_ANGLES.length)]!;
  const rest = POST_ANGLES.filter((a) => a !== start).sort(
    () => Math.random() - 0.5,
  );
  const n = Math.max(1, Math.min(5, count));
  return [start, ...rest].slice(0, n);
}

function normalizeHashtags(
  tags: string[] | undefined,
  category: string,
): string[] {
  const cleaned = (tags ?? [])
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);
  const base = cleaned.length ? cleaned : hashtagsFor(category);
  return [...new Set(base)].slice(0, 5);
}

type GeneratedPost = {
  angle?: string;
  content?: string;
  hashtags?: string[];
};

async function generateViaCursor(input: {
  topic: ContentTopic;
  angles: PostAngle[];
  allowBrand: boolean;
}): Promise<ContentDraft[]> {
  const system = generatePostsSystemPrompt();
  const user = generatePostsUserPrompt({
    topic: input.topic,
    angles: input.angles,
    brandMention: input.allowBrand,
  });

  const parsed = await cursorPromptJson<{ posts?: GeneratedPost[] }>(
    `${system}\n\n---\n\n${user}`,
  );

  return mapGeneratedPosts(parsed.posts ?? [], input);
}

async function generateViaOpenAi(input: {
  topic: ContentTopic;
  angles: PostAngle[];
  allowBrand: boolean;
}): Promise<ContentDraft[]> {
  const raw = await chatCompletion({
    messages: [
      { role: "system", content: generatePostsSystemPrompt() },
      {
        role: "user",
        content: generatePostsUserPrompt({
          topic: input.topic,
          angles: input.angles,
          brandMention: input.allowBrand,
        }),
      },
    ],
    temperature: 0.85,
    maxTokens: 4000,
    json: true,
  });
  const parsed = parseJsonObject<{ posts?: GeneratedPost[] }>(raw);
  return mapGeneratedPosts(parsed.posts ?? [], input);
}

function mapGeneratedPosts(
  posts: GeneratedPost[],
  input: {
    topic: ContentTopic;
    angles: PostAngle[];
  },
): ContentDraft[] {
  const now = new Date().toISOString();
  const usable = posts.filter((p) => p.content?.trim());
  if (usable.length === 0) {
    throw new Error("Model returned no usable posts");
  }

  return usable.slice(0, input.angles.length).map((p, i) => {
    const angle = POST_ANGLES.includes(p.angle as PostAngle)
      ? (p.angle as PostAngle)
      : (input.angles[i] ?? "educational");
    const interests = listInterests();
    const interest =
      resolveInterestLabel(input.topic.interest, interests) ??
      matchInterest(
        `${input.topic.interest ?? ""} ${p.content} ${input.topic.title}`,
        interests,
      ) ??
      input.topic.interest;
    return attachScore(
      {
        id: slugId("draft", `${input.topic.id}-${angle}-${i}`),
        topicId: input.topic.id,
        topic: input.topic.title,
        category: input.topic.category,
        audience: input.topic.targetAudience,
        angle,
        interest,
        content: p.content!.trim(),
        hashtags: normalizeHashtags(p.hashtags, input.topic.category),
        status: "draft",
        generatedAt: now,
        source: "ai",
      },
      input.topic,
    );
  });
}

export async function generatePostsForTopic(input: {
  topic: ContentTopic;
  maxVariations: number;
  preferAi?: boolean;
}): Promise<{ drafts: ContentDraft[]; usedAi: boolean }> {
  const angles = pickAngles(
    input.maxVariations,
    String(input.topic.suggestedAngle),
  );
  const preferAi = input.preferAi ?? contentUseAi();
  const instructions = loadContentInstructions();
  const allowBrand = !forbidsBrandMention(instructions);

  if (!preferAi || !isAiAvailable()) {
    throw new Error(
      "Post generation requires Cursor CLI (`agent`, via login or CURSOR_API_KEY) or OPENAI_API_KEY. " +
        "Template conditionals were removed — run `agent login` or set CURSOR_API_KEY.",
    );
  }

  console.log(
    `[content] Generating ${angles.length} post(s) for "${input.topic.title}" via ${
      isCursorAvailable() ? "Cursor" : "OpenAI-compatible"
    }…`,
  );

  let drafts: ContentDraft[];
  if (isCursorAvailable()) {
    drafts = await generateViaCursor({
      topic: input.topic,
      angles,
      allowBrand,
    });
  } else {
    drafts = await generateViaOpenAi({
      topic: input.topic,
      angles,
      allowBrand,
    });
  }

  const refined: ContentDraft[] = [];
  for (const d of drafts) {
    const result = await validateAndRefineDraft({
      draft: d,
      topic: input.topic,
      instructions,
    });
    refined.push(
      attachScore(
        {
          id: result.draft.id,
          topicId: result.draft.topicId,
          topic: result.draft.topic,
          category: result.draft.category,
          audience: result.draft.audience,
          angle: result.draft.angle,
          interest: result.draft.interest ?? input.topic.interest,
          content: result.draft.content,
          hashtags: result.draft.hashtags,
          status: result.draft.status,
          generatedAt: result.draft.generatedAt,
          source: result.draft.source,
          refined: result.refined,
          instructionIssues: result.draft.instructionIssues,
        },
        input.topic,
      ),
    );
  }

  return { drafts: refined, usedAi: true };
}

export async function generatePostsForTopics(input: {
  topics: ContentTopic[];
  maxVariations: number;
  maxTopics?: number;
  preferAi?: boolean;
}): Promise<{ drafts: ContentDraft[]; usedAi: boolean }> {
  const topics = input.topics.slice(
    0,
    input.maxTopics ?? input.topics.length,
  );
  const all: ContentDraft[] = [];
  let usedAi = false;

  for (const topic of topics) {
    const result = await generatePostsForTopic({
      topic,
      maxVariations: input.maxVariations,
      preferAi: input.preferAi,
    });
    all.push(...result.drafts);
    usedAi = usedAi || result.usedAi;
  }

  const unique = dedupeDrafts(all);
  if (unique.length < all.length) {
    console.log(
      `[content] Kept ${unique.length}/${all.length} drafts after uniqueness filter`,
    );
  }
  unique.sort((a, b) => b.score - a.score);
  recordPublishedOrDrafted(unique);
  recordInterestUse(
    unique.map((d) => d.interest).filter(Boolean) as string[],
  );
  return { drafts: unique, usedAi };
}

export function formatDraftForLinkedIn(draft: ContentDraft): string {
  const tags = draft.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  return `${draft.content.trim()}\n\n${tags}`.trim();
}
