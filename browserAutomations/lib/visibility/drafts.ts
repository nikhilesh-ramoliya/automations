/** Draft LinkedIn posts to grow personal-profile visibility (never auto-publishes). */

import type { FoundPost, PostDraft } from "./types.js";
import { slugId } from "./io.js";

const TOPIC_BODIES: Record<string, string[]> = {
  AI: [
    `Most AI pilots stall for the same reason: the model works in a demo, but the workflow around it doesn't.

Before you pick a vendor, map the handoffs — who reviews output, what happens on a bad answer, and how success is measured in the first 30 days.

Curious how others are defining "done" for their first GenAI use case.`,
    `AI visibility tip from client work: treat prompts like product specs.

Version them. Assign an owner. Review failure cases weekly.

The teams that win aren't the ones with the flashiest model — they're the ones who iterate the operating system around it.`,
  ],
  automation: [
    `Automation isn't about replacing judgment — it's about removing the copy-paste tax so people can use judgment more often.

A useful test: if a task is done the same way 5+ times a week and the exceptions are documented, it's a candidate.

If the exceptions aren't documented, automate the documentation first.`,
    `The quiet ROI of automation: fewer context switches.

When status updates, handoffs, and data entry stop bouncing between five tools, teams reclaim hours — not because they work faster, but because they interrupt themselves less.`,
  ],
  "IT consulting": [
    `Good consulting leaves the client stronger without you.

That means writing the runbooks, pairing on the first releases, and measuring outcomes the client can see on their own dashboard.

If the engagement ends and only you understand the system, we didn't finish the job.`,
    `IT consulting is shifting from "build the thing" to "help the org absorb the thing."

Architecture still matters. So does change management, training, and a 90-day adoption plan.

That's where most of the value (and most of the risk) actually lives.`,
  ],
  "custom software": [
    `Custom software should feel boring in the best way: reliable, owned by your team, and shaped around how you actually work.

Buy when the problem is commodity. Build when the workflow is your advantage.

The expensive mistake is building a commodity — or buying something that fights your process every day.`,
    `A simple filter for build-vs-buy:

1) Is this differentiating for your business?
2) Can a package get you 80% without fighting your ops?
3) Who will maintain it in 18 months?

If you can't answer #3, pause before writing the first ticket.`,
  ],
};

function normalizeTopic(keyword: string): string {
  const k = keyword.trim().toLowerCase();
  if (k === "ai" || k.includes("genai") || k.includes("llm")) return "AI";
  if (k.includes("automat")) return "automation";
  if (k.includes("consult")) return "IT consulting";
  if (k.includes("software") || k.includes("custom")) return "custom software";
  return keyword.trim() || "AI";
}

function hashtagsFor(topic: string): string[] {
  switch (topic) {
    case "AI":
      return ["AI", "GenAI", "DigitalTransformation"];
    case "automation":
      return ["Automation", "OpsExcellence", "Productivity"];
    case "IT consulting":
      return ["ITConsulting", "TechLeadership", "Delivery"];
    case "custom software":
      return ["CustomSoftware", "SoftwareEngineering", "BuildVsBuy"];
    default:
      return ["LinkedIn", "Tech"];
  }
}

export function buildPostDrafts(input: {
  keywords: string[];
  posts: FoundPost[];
  maxDrafts: number;
}): PostDraft[] {
  const now = new Date().toISOString();
  const drafts: PostDraft[] = [];
  const topics = [
    ...new Set(input.keywords.map(normalizeTopic)),
  ].slice(0, input.maxDrafts);

  for (const topic of topics) {
    if (drafts.length >= input.maxDrafts) break;
    const bodies = TOPIC_BODIES[topic] ?? TOPIC_BODIES.AI;
    const variant = drafts.filter((d) => d.topic === topic).length % bodies.length;
    const inspired = input.posts
      .filter((p) => normalizeTopic(p.keyword) === topic)
      .slice(0, 3)
      .map((p) => p.id);

    drafts.push({
      id: slugId("draft", `${topic}-${variant}-${Date.now()}`),
      topic,
      body: bodies[variant] ?? bodies[0]!,
      hashtags: hashtagsFor(topic),
      inspiredByPostIds: inspired,
      draftedAt: now,
    });
  }

  // Fill remaining slots by rotating topics
  let i = 0;
  while (drafts.length < input.maxDrafts && topics.length > 0) {
    const topic = topics[i % topics.length]!;
    const bodies = TOPIC_BODIES[topic] ?? TOPIC_BODIES.AI;
    const variant = drafts.length % bodies.length;
    drafts.push({
      id: slugId("draft", `${topic}-extra-${drafts.length}`),
      topic,
      body: bodies[variant]!,
      hashtags: hashtagsFor(topic),
      inspiredByPostIds: [],
      draftedAt: now,
    });
    i += 1;
    if (i > input.maxDrafts * 2) break;
  }

  return drafts.slice(0, input.maxDrafts);
}

export function formatDraftForLinkedIn(draft: PostDraft): string {
  const tags = draft.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  return `${draft.body.trim()}\n\n${tags}`.trim();
}
