/** Brand voice + positioning for content drafts (respects instructions.md). */

import { contentBrandName } from "./env.js";
import { forbidsBrandMention } from "./instructions.js";

export function brandVoiceGuidelines(): string {
  const brand = contentBrandName();
  const noBrand = forbidsBrandMention();
  const lines = [
    "Position as a peer who has shipped systems — not a salesperson.",
    "Teach something useful; every post must provide value even if the reader never becomes a customer.",
    "Target: startup founders, CTOs, engineering managers, product leaders, teams evaluating outsourcing or AI automation.",
    "Tone: clear, practical, specific. No clickbait. No emoji spam (0–1 max, usually none).",
    "Avoid generic AI filler, buzzword stacks, and “in today's fast-paced world” openers.",
  ];
  if (noBrand) {
    lines.unshift(
      `Do NOT mention "${brand}" or any company name. No pitches, soft or hard.`,
    );
  } else {
    lines.unshift(
      `${brand} is an experienced engineering partner (IT consulting, custom software, AI automation).`,
    );
    lines.push(
      "Occasionally mention expertise naturally (at most one soft mention); never pitch hard CTAs or demos.",
    );
  }
  return lines.join("\n");
}

export function softBrandMention(brand = contentBrandName()): string {
  if (forbidsBrandMention()) return "";
  const variants = [
    `In client work at ${brand}, we see this pattern often.`,
    `Teams we partner with at ${brand} usually start here.`,
    `A lesson from delivery work at ${brand}:`,
  ];
  return variants[Math.floor(Math.random() * variants.length)]!;
}
