/** Content topic research — AI when configured, else curated template bank. */

import {
  chatCompletion,
  isAiAvailable,
  parseJsonObject,
} from "../ai/client.js";
import { cursorPromptJson, isCursorAvailable } from "../ai/cursor-agent.js";
import { contentUseAi } from "./env.js";
import { slugId } from "./io.js";
import {
  listInterests,
  matchInterest,
  pickInterestsForRun,
  recordInterestUse,
  resolveInterestLabel,
} from "./interests.js";
import {
  researchTopicsSystemPrompt,
  researchTopicsUserPrompt,
} from "./prompts.js";
import type { ContentTopic, PostAngle } from "./types.js";
import { POST_ANGLES } from "./types.js";
import { recentTopicTitles } from "./uniqueness.js";

type TopicSeed = {
  title: string;
  summary: string;
  category: string;
  targetAudience: string;
  reason: string;
  suggestedAngle: PostAngle;
  interest?: string;
};

/** Curated ideas aligned to Lanatus ICP — used when AI is off or fails. */
const TOPIC_BANK: TopicSeed[] = [
  {
    title: "Why most GenAI pilots stall after the demo",
    summary:
      "The model works in a slide deck, then dies in production because ownership, evaluation, and exception paths were never designed. A practical checklist for the first 30 days of an AI workflow.",
    category: "AI",
    targetAudience: "CTOs",
    reason:
      "Buyers evaluating AI automation need a sober delivery frame, not vendor hype.",
    suggestedAngle: "educational",
    interest: "AI automation",
  },
  {
    title: "Build vs buy when your workflow is the moat",
    summary:
      "Commodity features should be purchased. Differentiating workflows deserve custom software — but only if someone will own them in 18 months.",
    category: "Custom Software",
    targetAudience: "Startup founders",
    reason:
      "Founders often over-build commodities or buy tools that fight their process.",
    suggestedAngle: "founder_insight",
    interest: "Software architecture",
  },
  {
    title: "The automation candidates hiding in your ops calendar",
    summary:
      "If a task repeats 5+ times a week and exceptions are documented, it is automatable. If exceptions are tribal knowledge, document first.",
    category: "Automation",
    targetAudience: "Engineering Managers",
    reason:
      "Managers feel the copy-paste tax daily and want a filter that is not “automate everything.”",
    suggestedAngle: "technical_lesson",
    interest: "AI automation",
  },
  {
    title: "Playwright beyond tests: browser automation as a product skill",
    summary:
      "Stable selectors, human pacing, and recovery paths matter as much in ops bots as in CI. Lessons from shipping browser workflows that survive UI churn.",
    category: "Playwright",
    targetAudience: "Companies interested in AI automation",
    reason:
      "Teams adopting Playwright for RPA-style work need engineering discipline, not record-and-replay.",
    suggestedAngle: "technical_lesson",
    interest: "AI automation",
  },
  {
    title: "What “done” should mean for an MVP in 90 days",
    summary:
      "An MVP that cannot be operated by the client team is still a prototype. Scope for learning, observability, and a thin but real handoff.",
    category: "MVP Development",
    targetAudience: "Product Leaders",
    reason:
      "Product leaders under pressure to ship need a definition of done that includes adoption.",
    suggestedAngle: "opinion",
    interest: "Software architecture",
  },
  {
    title: "Scaling teams without scaling meeting debt",
    summary:
      "Headcount growth often multiplies status rituals. Lightweight written updates, clear decision owners, and fewer syncs that exist only from habit.",
    category: "Scaling Teams",
    targetAudience: "Engineering Managers",
    reason:
      "Growing engineering orgs feel coordination pain before they feel capacity gains.",
    suggestedAngle: "storytelling",
    interest: "Engineering leadership",
  },
  {
    title: "Cloud spend is a design smell, not just a finance problem",
    summary:
      "Unexpected bills usually trace to unbounded jobs, chatty services, or missing retention. Treat cost as an architecture review input.",
    category: "Cloud",
    targetAudience: "CTOs",
    reason:
      "CTOs own both reliability and budget; practical signals beat generic “optimize cloud” advice.",
    suggestedAngle: "educational",
    interest: "Software architecture",
  },
  {
    title: "DevOps that shrinks the gap between “merged” and “safe in prod”",
    summary:
      "CI green is not production-ready. Progressive delivery, rollback drills, and ownership of the last mile matter more than tool logos.",
    category: "DevOps",
    targetAudience: "Engineering Managers",
    reason:
      "Delivery credibility is a common reason companies look for an engineering partner.",
    suggestedAngle: "opinion",
    interest: "Software architecture",
  },
  {
    title: "Architecture decisions that age well under vague requirements",
    summary:
      "Prefer seams you can rewrite: clear module boundaries, boring data stores, and contracts that survive a pivot. Premature microservices rarely help.",
    category: "Architecture",
    targetAudience: "CTOs",
    reason:
      "Early-stage and mid-market teams keep paying interest on over-fragmented systems.",
    suggestedAngle: "technical_lesson",
    interest: "Software architecture",
  },
  {
    title: "Testing strategy for teams that ship weekly",
    summary:
      "Not every path needs an E2E. Risk-based coverage: unit for logic, contract for boundaries, few critical journeys in the browser.",
    category: "Testing",
    targetAudience: "Engineering Managers",
    reason:
      "Slow suites kill cadence; thin coverage kills trust. Leaders want a balanced default.",
    suggestedAngle: "educational",
    interest: "Engineering leadership",
  },
  {
    title: "SaaS onboarding fails when the product assumes tribal knowledge",
    summary:
      "Empty states, sample data, and a first-win path in under 15 minutes beat feature tours. Instrument where people abandon.",
    category: "SaaS",
    targetAudience: "Product Leaders",
    reason:
      "Product leaders feel activation metrics and need concrete product-engineering patterns.",
    suggestedAngle: "founder_insight",
    interest: "Software architecture",
  },
  {
    title: "When outsourcing works — and when it quietly fails",
    summary:
      "Outsourcing succeeds with crisp interfaces, shared definition of done, and internal owners. It fails when the vendor becomes the only person who understands the system.",
    category: "Case Studies",
    targetAudience: "Companies looking to outsource software development",
    reason:
      "Directly addresses buyers evaluating an engineering partner without a hard pitch.",
    suggestedAngle: "storytelling",
    interest: "Engineering leadership",
  },
  {
    title: "Performance work that starts with a question, not a profiler",
    summary:
      "Ask what “fast enough” means for the user journey, then measure that path. Premature optimization burns weeks on endpoints nobody waits on.",
    category: "Performance",
    targetAudience: "Engineering Managers",
    reason:
      "Practical framing for teams under pressure to “make it faster.”",
    suggestedAngle: "educational",
    interest: "Software architecture",
  },
  {
    title: "Engineering leadership is mostly decision hygiene",
    summary:
      "Who decides, by when, with what input, and how we revisit. Clear decision logs reduce thrash more than motivational speeches.",
    category: "Engineering Leadership",
    targetAudience: "Engineering Managers",
    reason:
      "Managers and directors in our ICP struggle with ambiguity more than raw coding capacity.",
    suggestedAngle: "opinion",
    interest: "Engineering leadership",
  },
  {
    title: "Product development without the roadmap theater",
    summary:
      "A living backlog of bets, outcomes, and kill criteria beats a 12-month feature mural that everyone knows is fiction.",
    category: "Product Development",
    targetAudience: "Product Leaders",
    reason:
      "Product + eng alignment is a frequent inbound conversation theme.",
    suggestedAngle: "founder_insight",
    interest: "Engineering leadership",
  },
  {
    title: "Software engineering craft that still matters with AI copilots",
    summary:
      "Copilots accelerate typing; they do not replace ownership of edge cases, observability, and review standards. Raise the bar on what “reviewed” means.",
    category: "Software Engineering",
    targetAudience: "CTOs",
    reason:
      "Timely: AI coding tools change throughput but not accountability.",
    suggestedAngle: "opinion",
    interest: "AI agents",
  },
];

function normalizeAngle(raw: string | undefined): PostAngle {
  const v = (raw ?? "").toLowerCase().replace(/\s+/g, "_");
  if ((POST_ANGLES as string[]).includes(v)) return v as PostAngle;
  if (v.includes("founder")) return "founder_insight";
  if (v.includes("opinion")) return "opinion";
  if (v.includes("technical") || v.includes("lesson")) return "technical_lesson";
  if (v.includes("stor")) return "storytelling";
  return "educational";
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function filterBank(categories: string[]): TopicSeed[] {
  if (!categories.length) return TOPIC_BANK;
  const set = new Set(categories.map((c) => c.toLowerCase()));
  const matched = TOPIC_BANK.filter((t) =>
    set.has(t.category.toLowerCase()) ||
    [...set].some((c) => t.category.toLowerCase().includes(c) || c.includes(t.category.toLowerCase())),
  );
  return matched.length ? matched : TOPIC_BANK;
}

function assignInterest(seed: {
  interest?: string;
  title: string;
  summary: string;
  category: string;
  reason: string;
}): string | undefined {
  const interests = listInterests();
  if (!interests.length) return seed.interest;
  return (
    resolveInterestLabel(seed.interest, interests) ??
    matchInterest(
      `${seed.interest ?? ""} ${seed.title} ${seed.summary} ${seed.category} ${seed.reason}`,
      interests,
    ) ??
    interests[0]
  );
}

export function researchTopicsFromTemplates(input: {
  maxTopics: number;
  categories: string[];
  audiences: string[];
}): ContentTopic[] {
  const now = new Date().toISOString();
  const recent = recentTopicTitles(24);
  const focus = pickInterestsForRun(input.maxTopics);
  const focusNorm = new Set(focus.map((i) => i.toLowerCase()));

  let filtered = filterBank(input.categories).filter(
    (t) => !recent.has(t.title.toLowerCase()),
  );
  if (focusNorm.size) {
    const preferred = filtered.filter((t) => {
      const assigned = assignInterest(t);
      return assigned && focusNorm.has(assigned.toLowerCase());
    });
    if (preferred.length) filtered = preferred;
  }

  const pool = shuffle(filtered.length ? filtered : filterBank(input.categories));
  const audiences =
    input.audiences.length > 0
      ? input.audiences
      : ["Startup founders", "CTOs", "Engineering Managers"];

  if (filtered.length < input.maxTopics) {
    console.log(
      `[content] Only ${filtered.length} unused topics in bank (skipped ${recent.size} recent); may reuse older ones`,
    );
  }

  const topics = pool.slice(0, input.maxTopics).map((seed, i) => {
    const audience =
      seed.targetAudience && audiences.includes(seed.targetAudience)
        ? seed.targetAudience
        : audiences[i % audiences.length]!;
    const interest = assignInterest(seed);
    return {
      id: slugId(
        "topic",
        seed.title,
        `${process.env.CONTENT_RUN_ID ?? "run"}-${i}`,
      ),
      title: seed.title,
      summary: seed.summary,
      category: seed.category,
      targetAudience: audience,
      reason: seed.reason,
      suggestedAngle: seed.suggestedAngle,
      interest,
      researchedAt: now,
      source: "template" as const,
    };
  });
  recordInterestUse(topics.map((t) => t.interest).filter(Boolean) as string[]);
  return topics;
}

async function researchTopicsWithAi(input: {
  maxTopics: number;
  categories: string[];
  audiences: string[];
}): Promise<ContentTopic[]> {
  const focusInterests = pickInterestsForRun(input.maxTopics);
  if (focusInterests.length) {
    console.log(
      `[content] Interest focus this run: ${focusInterests.join(", ")}`,
    );
  }
  const user = researchTopicsUserPrompt({
    count: input.maxTopics,
    categories: input.categories,
    audiences: input.audiences,
    focusInterests,
    avoidTitles: [...recentTopicTitles(16)],
  });
  const system = researchTopicsSystemPrompt();

  type TopicPayload = {
    topics?: Array<{
      title?: string;
      summary?: string;
      category?: string;
      targetAudience?: string;
      reason?: string;
      interest?: string;
      suggestedAngle?: string;
    }>;
  };

  let parsed: TopicPayload;
  if (isCursorAvailable()) {
    console.log("[content] Researching topics via Cursor…");
    parsed = await cursorPromptJson<TopicPayload>(`${system}\n\n---\n\n${user}`);
  } else {
    const raw = await chatCompletion({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.8,
      maxTokens: 3000,
      json: true,
    });
    parsed = parseJsonObject<TopicPayload>(raw);
  }

  const now = new Date().toISOString();
  const interests = listInterests();
  const topics = (parsed.topics ?? [])
    .filter((t) => t.title && t.summary)
    .slice(0, input.maxTopics)
    .map((t, i) => {
      const interest =
        resolveInterestLabel(t.interest, interests) ??
        matchInterest(
          `${t.interest ?? ""} ${t.title} ${t.summary} ${t.category ?? ""} ${t.reason ?? ""}`,
          interests,
        ) ??
        focusInterests[i % Math.max(focusInterests.length, 1)] ??
        interests[0];
      return {
        id: slugId(
          "topic",
          t.title!,
          `${process.env.CONTENT_RUN_ID ?? "run"}-${i}`,
        ),
        title: t.title!.trim(),
        summary: t.summary!.trim(),
        category: (t.category ?? input.categories[0] ?? "AI").trim(),
        targetAudience: (
          t.targetAudience ??
          input.audiences[0] ??
          "CTOs"
        ).trim(),
        reason: (t.reason ?? "Relevant to our ICP.").trim(),
        suggestedAngle: normalizeAngle(t.suggestedAngle),
        interest,
        researchedAt: now,
        source: "ai" as const,
      };
    });

  if (topics.length === 0) {
    throw new Error("AI returned no usable topics");
  }
  recordInterestUse(topics.map((t) => t.interest).filter(Boolean) as string[]);
  return topics;
}

/**
 * Research content topics. Prefers AI when configured; falls back to templates.
 */
export async function researchTopics(input: {
  maxTopics: number;
  categories: string[];
  audiences: string[];
  preferAi?: boolean;
}): Promise<{ topics: ContentTopic[]; usedAi: boolean }> {
  const preferAi = input.preferAi ?? contentUseAi();
  if (preferAi && isAiAvailable()) {
    try {
      const topics = await researchTopicsWithAi(input);
      return { topics, usedAi: true };
    } catch (err) {
      console.warn(
        `[content] AI topic research failed, using templates: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return {
    topics: researchTopicsFromTemplates(input),
    usedAi: false,
  };
}
