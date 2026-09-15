/**
 * Render a LinkedIn-sized post card (1200×627) from a draft + ## Image rules.
 * Copy/theme can be designed by Cursor/AI from instructions.md; HTML stays local.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { chatCompletion, isAiAvailable, parseJsonObject } from "../ai/client.js";
import { cursorPromptJson, isCursorAvailable } from "../ai/cursor-agent.js";
import { contentUseAi, envBool } from "./env.js";
import {
  imageInstructionsPromptBlock,
  resolveImageInstructions,
  type ImageCardInstructions,
} from "./instructions.js";
import type { ContentDraft } from "./types.js";

export const LINKEDIN_CARD_WIDTH = 1200;
export const LINKEDIN_CARD_HEIGHT = 627;

export type CardDesign = {
  kicker: string;
  headline: string;
  subhead: string;
  footer: string;
  layout: "title" | "quote";
  theme: "dark" | "light";
  background: string;
  accent: string;
  text: string;
  muted: string;
};

const DARK: Pick<CardDesign, "background" | "accent" | "text" | "muted"> = {
  background: "#0b1220",
  accent: "#5b8def",
  text: "#f4f7fb",
  muted: "#9fb4d4",
};

const LIGHT: Pick<CardDesign, "background" | "accent" | "text" | "muted"> = {
  background: "#f4f7fb",
  accent: "#1d4ed8",
  text: "#0b1220",
  muted: "#4b5d78",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isHexColor(value: string | undefined): value is string {
  return Boolean(value && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()));
}

function looksLikeCopyInstruction(value: string): boolean {
  return /\b(max|≤|<=|words?|rewrite|use |don't|do not|avoid|punchy|short|omit|never)\b/i.test(
    value,
  );
}

function shortenTitle(title: string, maxWords = 8): string {
  const words = title.replace(/\s+/g, " ").trim().split(" ");
  if (words.length <= maxWords) return title.trim();
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function bylineFrom(spec: ImageCardInstructions, angle: string): string {
  const parts = [spec.name, spec.role, spec.handle].filter(Boolean) as string[];
  return parts.join("  ·  ") || angle.replace(/_/g, " ");
}

function fallbackDesign(
  draft: ContentDraft,
  spec: ImageCardInstructions,
): CardDesign {
  const light = /\blight\b/i.test(`${spec.style ?? ""} ${spec.palette ?? ""}`);
  const quote = /\bquote\b/i.test(`${spec.style ?? ""} ${spec.layout ?? ""}`);
  const palette = light ? LIGHT : DARK;
  const headline =
    spec.headlineHint && !looksLikeCopyInstruction(spec.headlineHint)
      ? spec.headlineHint
      : shortenTitle(draft.topic || draft.content.slice(0, 80));
  const subhead =
    spec.subheadHint && !looksLikeCopyInstruction(spec.subheadHint)
      ? spec.subheadHint
      : "";
  const kicker =
    spec.kickerHint && !looksLikeCopyInstruction(spec.kickerHint)
      ? spec.kickerHint
      : draft.category || "Engineering";
  return {
    kicker,
    headline,
    subhead,
    footer: bylineFrom(spec, String(draft.angle || "insight")),
    layout: quote ? "quote" : "title",
    theme: light ? "light" : "dark",
    background: isHexColor(spec.background) ? spec.background : palette.background,
    accent: isHexColor(spec.accent) ? spec.accent : palette.accent,
    text: palette.text,
    muted: palette.muted,
  };
}

function sanitizeDesign(
  raw: Partial<CardDesign>,
  fallback: CardDesign,
): CardDesign {
  const layout = raw.layout === "quote" ? "quote" : "title";
  const theme = raw.theme === "light" ? "light" : "dark";
  const clip = (value: string | undefined, max: number, fb: string) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, max) || fb;
  return {
    kicker: clip(raw.kicker, 48, fallback.kicker),
    headline: clip(raw.headline, 90, fallback.headline),
    subhead: clip(raw.subhead, 120, fallback.subhead),
    footer: clip(raw.footer, 80, fallback.footer),
    layout,
    theme,
    background: isHexColor(raw.background) ? raw.background : fallback.background,
    accent: isHexColor(raw.accent) ? raw.accent : fallback.accent,
    text: isHexColor(raw.text) ? raw.text : fallback.text,
    muted: isHexColor(raw.muted) ? raw.muted : fallback.muted,
  };
}

function designPrompt(draft: ContentDraft, spec: ImageCardInstructions): string {
  const body = draft.content.replace(/\s+/g, " ").trim().slice(0, 500);
  return `Design copy and colors for a 1200×627 LinkedIn title card. Reply with JSON only.

${imageInstructionsPromptBlock(spec)}

Draft:
- Topic: ${draft.topic}
- Category: ${draft.category}
- Angle: ${draft.angle}
- Opening: ${body}

Required JSON shape:
{"kicker":"string","headline":"string","subhead":"string","footer":"string","layout":"title"|"quote","theme":"dark"|"light","background":"#hex","accent":"#hex","text":"#hex","muted":"#hex"}

Rules:
- headline is the hero line (usually ≤ 8 words unless instructions say otherwise)
- subhead is optional; one short clarifying line or ""
- kicker is a short uppercase-friendly label (category or theme)
- footer is the byline from instructions (name / role / handle) — do not invent a brand
- colors must be #RRGGBB and match Style/Palette if given
- no company pitch, no hashtags, no emojis unless instructions allow them
- do not put the full post body on the card`;
}

async function designCardWithAi(
  draft: ContentDraft,
  spec: ImageCardInstructions,
  fallback: CardDesign,
): Promise<CardDesign> {
  const prompt = designPrompt(draft, spec);
  let parsed: Partial<CardDesign>;
  if (isCursorAvailable()) {
    parsed = await cursorPromptJson<Partial<CardDesign>>(prompt);
  } else {
    const raw = await chatCompletion({
      messages: [
        {
          role: "system",
          content:
            "You design LinkedIn title cards. Reply with one JSON object only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.6,
      maxTokens: 800,
      json: true,
    });
    parsed = parseJsonObject<Partial<CardDesign>>(raw);
  }
  return sanitizeDesign(parsed, fallback);
}

function cardHtml(design: CardDesign): string {
  const kicker = escapeHtml(design.kicker);
  const headline = escapeHtml(design.headline);
  const subhead = escapeHtml(design.subhead);
  const footer = escapeHtml(design.footer);
  const quote = design.layout === "quote";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; padding: 0; width: ${LINKEDIN_CARD_WIDTH}px; height: ${LINKEDIN_CARD_HEIGHT}px; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: ${design.background};
      color: ${design.text};
      overflow: hidden;
    }
    .frame {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: 56px 64px;
      background:
        radial-gradient(circle at 110% -10%, ${design.accent}55 0%, transparent 42%),
        ${design.background};
      border: 1px solid ${design.accent}33;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .kicker {
      display: flex;
      gap: 10px;
      align-items: center;
      font-size: 20px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: ${design.muted};
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: ${design.accent}; flex-shrink: 0; }
    h1 {
      margin: ${quote ? "8px 0 0" : "24px 0 0"};
      font-size: ${quote ? "48px" : "52px"};
      line-height: 1.16;
      font-weight: 650;
      max-width: ${quote ? "22ch" : "16ch"};
    }
    .sub {
      margin: 18px 0 0;
      font-size: 24px;
      line-height: 1.35;
      color: ${design.muted};
      max-width: 36ch;
    }
    .meta {
      font-size: 20px;
      color: ${design.muted};
    }
  </style>
</head>
<body>
  <div class="frame">
    <div>
      <div class="kicker"><span class="dot"></span>${kicker}</div>
      <h1>${quote ? `“${headline}”` : headline}</h1>
      ${subhead ? `<div class="sub">${subhead}</div>` : ""}
    </div>
    <div class="meta">${footer}</div>
  </div>
</body>
</html>`;
}

export function defaultCardPath(runDir: string, draftId: string): string {
  return path.join(runDir, "images", `${draftId}.png`);
}

export async function designDraftCard(
  draft: ContentDraft,
): Promise<CardDesign> {
  const spec = resolveImageInstructions();
  const fallback = fallbackDesign(draft, spec);
  const useAi =
    envBool("CONTENT_IMAGE_AI", true) &&
    contentUseAi() &&
    (isCursorAvailable() || isAiAvailable());
  if (!useAi) return fallback;
  try {
    const designed = await designCardWithAi(draft, spec, fallback);
    console.log(
      `[content-compose] Card copy from ${isCursorAvailable() ? "Cursor" : "AI"}: "${designed.headline}"`,
    );
    return designed;
  } catch (err) {
    console.warn(
      `[content-compose] Card design fallback (template): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return fallback;
  }
}

export async function renderDraftCard(
  draft: ContentDraft,
  outPath: string,
): Promise<string> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const design = await designDraftCard(draft);
  const specPath = outPath.replace(/\.png$/i, ".json");
  fs.writeFileSync(specPath, JSON.stringify(design, null, 2) + "\n", "utf8");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: LINKEDIN_CARD_WIDTH, height: LINKEDIN_CARD_HEIGHT },
      deviceScaleFactor: 1,
    });
    await page.setContent(cardHtml(design), { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: outPath, type: "png" });
  } finally {
    await browser.close();
  }
  return outPath;
}
