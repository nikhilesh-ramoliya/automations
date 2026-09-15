/**
 * User-editable content instructions (`data/content/instructions.md`).
 * Required sections: Must / Never. Optional: Interests / Voice / Prefer / Notes / Image.
 */

import fs from "node:fs";
import path from "node:path";
import {
  chatCompletion,
  isAiAvailable,
  parseJsonObject,
} from "../ai/client.js";
import { cursorPromptJson, isCursorAvailable } from "../ai/cursor-agent.js";
import { PROJECT_ROOT } from "../paths.js";
import { contentBrandName, contentUseAi } from "./env.js";
import type { ContentDraft, ContentTopic } from "./types.js";

export type InstructionSections = {
  interests: string[];
  voice: string[];
  must: string[];
  never: string[];
  prefer: string[];
  notes: string[];
};

export type LoadedInstructions = {
  path: string;
  raw: string;
  sections: InstructionSections;
  usingDefaults: boolean;
};

export type InstructionIssue = {
  severity: "must" | "never";
  rule: string;
  detail: string;
};

export type ValidateResult = {
  ok: boolean;
  issues: InstructionIssue[];
};

const DEFAULT_INSTRUCTIONS_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "content",
  "instructions.md",
);

function emptySections(): InstructionSections {
  return {
    interests: [],
    voice: [],
    must: [],
    never: [],
    prefer: [],
    notes: [],
  };
}

export function instructionsPath(): string {
  const explicit = process.env.CONTENT_INSTRUCTIONS_PATH?.trim();
  if (!explicit) return DEFAULT_INSTRUCTIONS_PATH;
  return path.isAbsolute(explicit)
    ? explicit
    : path.join(PROJECT_ROOT, explicit);
}

export type ImageCardCredits = {
  name?: string;
  role?: string;
  handle?: string;
};

/** Parsed `## Image` block — credits plus generation rules. */
export type ImageCardInstructions = ImageCardCredits & {
  style?: string;
  palette?: string;
  layout?: string;
  headlineHint?: string;
  subheadHint?: string;
  kickerHint?: string;
  background?: string;
  accent?: string;
  /** Freeform bullets (style rules, must/never for the card). */
  rules: string[];
};

const IMAGE_FIELD_ALIASES: Record<string, keyof Omit<ImageCardInstructions, "rules">> =
  {
    name: "name",
    byline: "name",
    role: "role",
    title: "role",
    handle: "handle",
    username: "handle",
    style: "style",
    theme: "style",
    palette: "palette",
    colors: "palette",
    colour: "palette",
    layout: "layout",
    headline: "headlineHint",
    hook: "headlineHint",
    subhead: "subheadHint",
    subtitle: "subheadHint",
    subheading: "subheadHint",
    kicker: "kickerHint",
    background: "background",
    accent: "accent",
  };

function parseImageFieldLine(
  line: string,
): { key: keyof Omit<ImageCardInstructions, "rules">; value: string } | null {
  const m = line.match(/^([A-Za-z][\w\s/-]*)\s*:\s*(.*)$/);
  if (!m) return null;
  const alias = m[1]!.trim().toLowerCase().replace(/[\s/-]+/g, "");
  const key = IMAGE_FIELD_ALIASES[alias];
  if (!key) return null;
  return { key, value: m[2]!.trim() };
}

function extractImageSection(raw: string): string[] {
  const lines: string[] = [];
  let inImage = false;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(\w[\w\s]*)\s*$/);
    if (heading) {
      inImage = /^image$/i.test(heading[1]!.trim());
      continue;
    }
    if (!inImage) continue;
    if (/^#/.test(line) || /^---\s*$/.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

/** Optional ## Image section: credits + style/layout/headline rules. */
export function parseImageInstructions(raw: string): ImageCardInstructions {
  const spec: ImageCardInstructions = { rules: [] };
  for (const line of extractImageSection(raw)) {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (!bullet) continue;
    const text = bullet[1]!.trim();
    if (!text) continue;
    const parsed = parseImageFieldLine(text);
    if (parsed) {
      if (parsed.value) spec[parsed.key] = parsed.value;
      continue;
    }
    spec.rules.push(text);
  }
  return spec;
}

/** @deprecated use parseImageInstructions */
export function parseImageCredits(raw: string): ImageCardCredits {
  const spec = parseImageInstructions(raw);
  return { name: spec.name, role: spec.role, handle: spec.handle };
}

export function resolveImageInstructions(
  raw = loadContentInstructions().raw,
): ImageCardInstructions {
  const fromFile = parseImageInstructions(raw);
  return {
    ...fromFile,
    name: process.env.CONTENT_IMAGE_NAME?.trim() || fromFile.name,
    role: process.env.CONTENT_IMAGE_ROLE?.trim() || fromFile.role,
    handle: process.env.CONTENT_IMAGE_HANDLE?.trim() || fromFile.handle,
    style: process.env.CONTENT_IMAGE_STYLE?.trim() || fromFile.style,
    palette: process.env.CONTENT_IMAGE_PALETTE?.trim() || fromFile.palette,
    layout: process.env.CONTENT_IMAGE_LAYOUT?.trim() || fromFile.layout,
    headlineHint:
      process.env.CONTENT_IMAGE_HEADLINE?.trim() || fromFile.headlineHint,
    background: process.env.CONTENT_IMAGE_BACKGROUND?.trim() || fromFile.background,
    accent: process.env.CONTENT_IMAGE_ACCENT?.trim() || fromFile.accent,
  };
}

export function resolveImageCredits(
  raw = loadContentInstructions().raw,
): ImageCardCredits {
  const spec = resolveImageInstructions(raw);
  return { name: spec.name, role: spec.role, handle: spec.handle };
}

export function imageInstructionsPromptBlock(
  spec = resolveImageInstructions(),
): string {
  const parts: string[] = [
    "TITLE CARD instructions (highest priority for the image — not the post body):",
  ];
  const add = (label: string, value?: string) => {
    if (value) parts.push(`- ${label}: ${value}`);
  };
  add("Style", spec.style);
  add("Palette", spec.palette);
  add("Layout", spec.layout);
  add("Headline", spec.headlineHint);
  add("Subhead", spec.subheadHint);
  add("Kicker", spec.kickerHint);
  add("Background", spec.background);
  add("Accent", spec.accent);
  const byline = [spec.name, spec.role, spec.handle].filter(Boolean).join(" · ");
  if (byline) parts.push(`- Byline (show on card): ${byline}`);
  if (spec.rules.length) {
    parts.push("Rules:");
    for (const rule of spec.rules) parts.push(`- ${rule}`);
  }
  if (parts.length === 1) {
    parts.push("(no extra image rules — use a clean dark editorial title card)");
  }
  return parts.join("\n");
}

export function parseInstructionsMarkdown(raw: string): InstructionSections {
  const sections = emptySections();
  let current: keyof InstructionSections | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(
      /^##\s+(interests|voice|must|never|prefer|notes)\s*$/i,
    );
    if (heading) {
      current = heading[1]!.toLowerCase() as keyof InstructionSections;
      continue;
    }
    if (/^##\s+/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (/^#/.test(line) || /^---\s*$/.test(line)) continue;

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      const text = bullet[1]!.trim();
      if (text && text !== "-") sections[current].push(text);
      continue;
    }
    if (current === "notes") {
      const t = line.trim();
      if (t) sections.notes.push(t);
    }
  }
  return sections;
}

export function loadContentInstructions(): LoadedInstructions {
  const filePath = instructionsPath();
  if (!fs.existsSync(filePath)) {
    const fallback = [
      "## Must",
      "- End with exactly one discussion question",
      "- Body 150–300 words (excluding hashtags)",
      "- 3–5 relevant hashtags",
      "## Never",
      '- Do not mention the brand "Lanatus" or any company pitch',
      '- No hard-sell: "book a call", "book a demo"',
      '- No filler: "in today\'s fast-paced world", "synergy"',
    ].join("\n");
    return {
      path: filePath,
      raw: fallback,
      sections: parseInstructionsMarkdown(fallback),
      usingDefaults: true,
    };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return {
    path: filePath,
    raw,
    sections: parseInstructionsMarkdown(raw),
    usingDefaults: false,
  };
}

/** True when Never/Must forbid naming the company brand. */
export function forbidsBrandMention(
  loaded = loadContentInstructions(),
): boolean {
  const brand = contentBrandName().toLowerCase();
  const rules = [
    ...loaded.sections.never,
    ...loaded.sections.must,
    ...loaded.sections.prefer,
  ];
  return rules.some((r) => {
    const lower = r.toLowerCase();
    if (lower.includes(`"${brand}"`) || lower.includes(`'${brand}'`)) {
      return /do not|don't|never|no mention|not mention|avoid/i.test(r);
    }
    return (
      /do not mention.*(brand|company)|never (a )?pitch|no (company )?pitch|don't mention.*brand|not mention brand/i.test(
        r,
      )
    );
  });
}

export function instructionsPromptBlock(
  loaded = loadContentInstructions(),
): string {
  const s = loaded.sections;
  const parts: string[] = [
    "REQUIRED user instructions (highest priority — violate none of Must/Never):",
  ];
  const add = (label: string, items: string[]) => {
    if (!items.length) return;
    parts.push(`\n${label}:`);
    for (const i of items) parts.push(`- ${i}`);
  };
  add("Interests (every topic/post must clearly relate to at least one)", s.interests);
  add("Must", s.must);
  add("Never", s.never);
  add("Voice", s.voice);
  add("Prefer", s.prefer);
  if (s.notes.length) {
    parts.push("\nNotes:");
    parts.push(s.notes.join("\n"));
  }
  if (forbidsBrandMention(loaded)) {
    parts.push(
      `\nCRITICAL: Do not mention "${contentBrandName()}" or any company name/pitch.`,
    );
  }
  if (parts.length === 1) {
    parts.push("(no rules in instructions.md yet)");
  }
  return parts.join("\n");
}

function extractQuotedPhrases(rule: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rule))) {
    out.push((m[1] ?? m[2] ?? "").trim());
  }
  return out.filter(Boolean);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasDiscussionQuestion(text: string): boolean {
  const lines = text
    .trim()
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-3).join(" ");
  return /\?/.test(tail);
}

function emojiCount(text: string): number {
  return (text.match(/[\u{1F300}-\u{1FAFF}]/gu) ?? []).length;
}

function stripBrandMentions(text: string, brand: string): string {
  const re = new RegExp(
    `\\b(?:in client work at|teams we partner with at|a lesson from delivery work at|at)\\s+${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,:]?\\s*`,
    "gi",
  );
  let out = text.replace(re, "");
  const brandRe = new RegExp(
    `\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "gi",
  );
  out = out.replace(brandRe, "");
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Validate a draft against Must / Never only (hard rules).
 */
export function validateAgainstInstructions(
  content: string,
  hashtags: string[],
  loaded = loadContentInstructions(),
): ValidateResult {
  const issues: InstructionIssue[] = [];
  const body = content.trim();
  const lower = body.toLowerCase();
  const words = wordCount(body);
  const s = loaded.sections;
  const brand = contentBrandName();

  // Always enforce brand ban when instructions say so
  if (forbidsBrandMention(loaded) && lower.includes(brand.toLowerCase())) {
    issues.push({
      severity: "never",
      rule: `Do not mention the brand "${brand}"`,
      detail: `Brand name "${brand}" found in post`,
    });
  }

  for (const rule of s.never) {
    const phrases = extractQuotedPhrases(rule);
    for (const p of phrases) {
      if (p && lower.includes(p.toLowerCase())) {
        // Brand already reported above
        if (p.toLowerCase() === brand.toLowerCase()) continue;
        issues.push({
          severity: "never",
          rule,
          detail: `Forbidden phrase found: "${p}"`,
        });
      }
    }
    if (/hard-?sell|clickbait|hype/i.test(rule)) {
      if (
        /\b(book a (call|demo)|dm me for pricing|limited time|click the link)\b/i.test(
          body,
        )
      ) {
        issues.push({
          severity: "never",
          rule,
          detail: "Hard-sell / CTA language detected",
        });
      }
    }
    if (/filler|synergy|game-?changer|fast-paced/i.test(rule)) {
      if (
        /\b(in today's fast-paced|game[- ]changer|unlock the power|synergy|revolutionize)\b/i.test(
          body,
        )
      ) {
        issues.push({
          severity: "never",
          rule,
          detail: "Filler / hype language detected",
        });
      }
    }
    if (/emoji/i.test(rule) && emojiCount(body) > 1) {
      issues.push({
        severity: "never",
        rule,
        detail: `Too many emojis (${emojiCount(body)})`,
      });
    }
    if (
      /guarante/i.test(rule) &&
      /\b(100%|guaranteed results|guarantee[sd]?)\b/i.test(body)
    ) {
      issues.push({
        severity: "never",
        rule,
        detail: "Guarantee / absolute claim detected",
      });
    }
    if (/pitch|company pitch/i.test(rule) && !forbidsBrandMention(loaded)) {
      if (
        /\b(book a (call|demo)|hire us|our (services|offering)|contact us today)\b/i.test(
          body,
        )
      ) {
        issues.push({
          severity: "never",
          rule,
          detail: "Company pitch language detected",
        });
      }
    }
  }

  for (const rule of s.must) {
    if (
      /discussion question|end with.*question/i.test(rule) &&
      !hasDiscussionQuestion(body)
    ) {
      issues.push({
        severity: "must",
        rule,
        detail: "Missing discussion question near the end",
      });
    }
    if (/150\s*[-–]\s*300|150 to 300|word/i.test(rule)) {
      if (words < 140 || words > 320) {
        issues.push({
          severity: "must",
          rule,
          detail: `Word count ${words} outside 150–300 target`,
        });
      }
    }
    if (/3\s*[-–]\s*5.*hashtag|hashtags/i.test(rule)) {
      const n = hashtags.filter(Boolean).length;
      if (n < 3 || n > 5) {
        issues.push({
          severity: "must",
          rule,
          detail: `Hashtag count ${n} (want 3–5)`,
        });
      }
    }
    if (/hook/i.test(rule)) {
      const first = body.split("\n").find((l) => l.trim()) ?? "";
      if (first.length < 15) {
        issues.push({
          severity: "must",
          rule,
          detail: "Opening hook looks too thin",
        });
      }
    }
    if (
      (/zero emoji|one maximum|emoji/i.test(rule) && emojiCount(body) > 1) ||
      (/zero emoji/i.test(rule) && emojiCount(body) > 0)
    ) {
      // "Zero emojis (one maximum)" → allow 0–1
      if (emojiCount(body) > 1) {
        issues.push({
          severity: "must",
          rule,
          detail: `Emoji count ${emojiCount(body)} exceeds max 1`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

const PAD_OPTIONS = [
  "Write the exception path before you scale the happy path — most failures hide there.",
  "Measure one outcome for two weeks before changing tools again.",
  "Name a single owner for the result, not just for the ticket queue.",
  "Prefer a thinner slice you can operate next month over a roadmap mural.",
];

function deterministicRefine(
  content: string,
  hashtags: string[],
  issues: InstructionIssue[],
  loaded: LoadedInstructions,
): { content: string; hashtags: string[] } {
  let text = content;
  const brand = contentBrandName();

  if (
    forbidsBrandMention(loaded) ||
    issues.some((i) => /brand/i.test(i.detail) || /Lanatus/i.test(i.detail))
  ) {
    text = stripBrandMentions(text, brand);
  }

  for (const issue of issues) {
    if (issue.severity !== "never" && issue.severity !== "must") continue;
    const phrases = extractQuotedPhrases(issue.rule);
    for (const p of phrases) {
      if (!p || p.toLowerCase() === brand.toLowerCase()) continue;
      const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      text = text.replace(re, "").replace(/[ \t]{2,}/g, " ");
    }
  }

  text = text
    .replace(
      /\b(book a (call|demo)|dm me for pricing|limited time offer|click the link below)\b/gi,
      "",
    )
    .replace(
      /\b(in today's fast-paced world[,.]?\s*|game-?changer|unlock the power of|synergy)\b/gi,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Pad short posts once with a single short line (avoid stacking across refine passes)
  if (issues.some((i) => /Word count/i.test(i.detail) && /outside/i.test(i.detail))) {
    if (wordCount(text) < 140) {
      const pad =
        PAD_OPTIONS.find((p) => !text.includes(p)) ??
        "Keep the first release boring enough that someone else can run it.";
      const qMatch = text.match(/\n\n([^\n]*\?\s*)$/);
      const question = qMatch?.[1];
      const body = question ? text.slice(0, -qMatch![0].length).trim() : text;
      text = question ? `${body}\n\n${pad}\n\n${question}` : `${body}\n\n${pad}`;
    }
  }

  if (
    issues.some(
      (i) =>
        /discussion question/i.test(i.rule) ||
        /Missing discussion/i.test(i.detail),
    ) &&
    !hasDiscussionQuestion(text)
  ) {
    text = `${text}\n\nWhat has worked on your side?`;
  }

  let tags = [...hashtags];
  if (issues.some((i) => /Hashtag count/i.test(i.detail))) {
    const fallback = ["SoftwareEngineering", "TechLeadership", "BuildInPublic"];
    while (tags.length < 3) tags.push(fallback[tags.length]!);
    tags = tags.slice(0, 5);
  }

  return { content: text.trim(), hashtags: tags };
}

async function aiRefine(input: {
  content: string;
  hashtags: string[];
  topic: ContentTopic;
  issues: InstructionIssue[];
  instructions: LoadedInstructions;
}): Promise<{ content: string; hashtags: string[] } | undefined> {
  if (!contentUseAi() || !isAiAvailable()) return undefined;
  try {
    const system =
      "You refine LinkedIn posts to satisfy REQUIRED Must/Never instructions. " +
      "Keep the same angle and core insight. Return ONLY JSON: " +
      `{ "content": string, "hashtags": string[] }. ` +
      "Hashtags: 3–5 words without #.\n\n" +
      instructionsPromptBlock(input.instructions);
    const user =
      `Topic: ${input.topic.title}\nAudience: ${input.topic.targetAudience}\n\n` +
      `Conflicts to fix:\n${input.issues.map((i) => `- [${i.severity}] ${i.detail} (rule: ${i.rule})`).join("\n")}\n\n` +
      `Current post:\n${input.content}\n\nHashtags: ${input.hashtags.join(", ")}`;

    let parsed: { content?: string; hashtags?: string[] };
    if (isCursorAvailable()) {
      parsed = await cursorPromptJson(`${system}\n\n---\n\n${user}`);
    } else {
      const raw = await chatCompletion({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
        maxTokens: 2000,
        json: true,
      });
      parsed = parseJsonObject(raw);
    }

    if (!parsed.content?.trim()) return undefined;
    let content = parsed.content.trim();
    if (forbidsBrandMention(input.instructions)) {
      content = stripBrandMentions(content, contentBrandName());
    }
    return {
      content,
      hashtags: (parsed.hashtags ?? input.hashtags)
        .map((h) => h.replace(/^#/, "").trim())
        .filter(Boolean)
        .slice(0, 5),
    };
  } catch (err) {
    console.warn(
      `[content] AI refine failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Validate a draft; on Must/Never conflicts, refine and re-validate (up to 2 passes).
 */
export async function validateAndRefineDraft(input: {
  draft: ContentDraft;
  topic: ContentTopic;
  instructions?: LoadedInstructions;
}): Promise<{
  draft: ContentDraft;
  issues: InstructionIssue[];
  refined: boolean;
}> {
  const instructions = input.instructions ?? loadContentInstructions();
  let draft = { ...input.draft };
  let issues = validateAgainstInstructions(
    draft.content,
    draft.hashtags,
    instructions,
  ).issues;
  let refined = false;

  for (let pass = 0; pass < 2 && issues.length > 0; pass++) {
    const onlyWordCount =
      issues.length > 0 &&
      issues.every((i) => /Word count/i.test(i.detail));
    console.log(
      `[content] ${issues.length} instruction conflict(s) on ${draft.id} — refining (pass ${pass + 1})`,
    );

    const ai = onlyWordCount
      ? undefined
      : await aiRefine({
          content: draft.content,
          hashtags: draft.hashtags,
          topic: input.topic,
          issues,
          instructions,
        });
    if (ai) {
      draft = { ...draft, content: ai.content, hashtags: ai.hashtags };
    } else {
      const fixed = deterministicRefine(
        draft.content,
        draft.hashtags,
        issues,
        instructions,
      );
      draft = { ...draft, content: fixed.content, hashtags: fixed.hashtags };
    }
    refined = true;
    issues = validateAgainstInstructions(
      draft.content,
      draft.hashtags,
      instructions,
    ).issues;
    // Word-count-only: one pad pass is enough
    if (onlyWordCount) break;
  }

  if (issues.length > 0) {
    console.warn(
      `[content] ${issues.length} issue(s) remain on ${draft.id}: ${issues.map((i) => i.detail).join("; ")}`,
    );
  }

  return {
    draft: {
      ...draft,
      refined,
      instructionIssues: issues.map(formatIssue),
    },
    issues,
    refined,
  };
}

function formatIssue(i: InstructionIssue): string {
  return `[${i.severity}] ${i.detail}`;
}
