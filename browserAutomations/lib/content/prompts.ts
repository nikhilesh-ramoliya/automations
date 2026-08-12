/** Prompt builders for content research + post generation. */

import { brandVoiceGuidelines } from "./brand.js";
import {
  instructionsPromptBlock,
  loadContentInstructions,
} from "./instructions.js";
import type { ContentTopic, PostAngle } from "./types.js";

export function researchTopicsSystemPrompt(): string {
  return `Generate LinkedIn content topic ideas. Reply with JSON only (no conversation).

Context: IT consulting / custom software firm. Build authority; not salesy.
${brandVoiceGuidelines()}

${instructionsPromptBlock(loadContentInstructions())}

Required JSON shape:
{"topics":[{"title":"string","summary":"string","category":"string","targetAudience":"string","reason":"string","interest":"string","suggestedAngle":"educational"|"founder_insight"|"opinion"|"technical_lesson"|"storytelling"}]}

Each topic MUST set "interest" to exactly one Interests theme from the instructions (same wording).`;
}

export function researchTopicsUserPrompt(input: {
  count: number;
  categories: string[];
  audiences: string[];
  focusInterests: string[];
  avoidTitles?: string[];
}): string {
  const avoid =
    input.avoidTitles && input.avoidTitles.length
      ? `\nDo NOT reuse these recent titles:\n${input.avoidTitles.map((t) => `- ${t}`).join("\n")}`
      : "";
  const interests =
    input.focusInterests.length > 0
      ? `Prioritize these Interests for this batch (cover each at least once if count allows):\n${input.focusInterests.map((i) => `- ${i}`).join("\n")}`
      : "Pick Interests from the instructions list; stay on-theme.";
  return `Return a JSON object with exactly ${input.count} distinct topics.

${interests}

Focus categories (mix, only if they support an Interest): ${input.categories.join(", ")}
Primary audiences: ${input.audiences.join("; ")}
${avoid}

Each topic: specific title (no clickbait), 2–3 sentence summary, category, one audience, relevance reason, interest (exact Interest label), suggestedAngle.`;
}

export function generatePostsSystemPrompt(): string {
  return `Write LinkedIn posts. Reply with JSON only (no conversation).

${brandVoiceGuidelines()}

${instructionsPromptBlock(loadContentInstructions())}

Every post: 150–300 words; strong hook; practical insight; short paragraphs; end with one discussion question; 3–5 hashtags (plain words, no #); zero/one emoji max; distinct if multiple angles.
Stay clearly inside the assigned Interest theme.

Required JSON shape:
{"posts":[{"angle":"educational"|"founder_insight"|"opinion"|"technical_lesson"|"storytelling","content":"string","hashtags":["string"]}]}`;
}

export function generatePostsUserPrompt(input: {
  topic: ContentTopic;
  angles: PostAngle[];
  brandMention: boolean;
}): string {
  const mention = input.brandMention
    ? "Include one natural soft mention of delivery experience (no hard sell)."
    : "Do NOT mention any company or brand name.";
  const interestLine = input.topic.interest
    ? `Interest (must stay on this theme): ${input.topic.interest}`
    : "Interest: stay within Interests listed in the instructions.";

  return `Return a JSON object with exactly ${input.angles.length} post(s). Angles: ${input.angles.join(", ")}.
Each angle must be a different post (different hook/examples/structure).

Title: ${input.topic.title}
Summary: ${input.topic.summary}
Category: ${input.topic.category}
Audience: ${input.topic.targetAudience}
Relevance: ${input.topic.reason}
${interestLine}
${mention}`;
}
