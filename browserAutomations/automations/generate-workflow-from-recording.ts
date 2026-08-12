import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOGS_DIR = path.join(projectRoot, "logs");
const GENERATED_DIR = path.join(projectRoot, "automations", "generated");

type RecordEvent = {
  ts: string;
  type: string;
  url?: string;
  tag?: string;
  id?: string;
  name?: string;
  role?: string;
  ariaName?: string;
  typeAttr?: string;
  text?: string;
  selectorHint?: string;
  value?: string;
  key?: string;
  redacted?: boolean;
  startUrls?: string[];
  [key: string]: unknown;
};

type ReplayStep =
  | { kind: "goto"; url: string; comment?: string }
  | {
      kind: "click";
      role?: string;
      name?: string;
      selectorHint?: string;
      text?: string;
      comment?: string;
      fragile?: boolean;
    }
  | {
      kind: "fill";
      role?: string;
      name?: string;
      selectorHint?: string;
      value: string;
      comment?: string;
      fragile?: boolean;
    }
  | { kind: "press"; key: string; comment?: string };

function escapeTsString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function findNewestRecording(): string | null {
  if (!fs.existsSync(LOGS_DIR)) return null;
  const files = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => /^recording-.*\.jsonl$/i.test(f))
    .map((f) => ({
      f,
      mtime: fs.statSync(path.join(LOGS_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] ? path.join(LOGS_DIR, files[0].f) : null;
}

function resolveRecordingPath(): string {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const fromEnv = process.env.RECORDING_PATH?.trim();
  const candidate = arg || fromEnv || findNewestRecording();

  if (!candidate) {
    console.error(
      "No recording found. Pass a path, set RECORDING_PATH, or run `npm run record:linkedin` first.",
    );
    process.exit(1);
  }

  const resolved = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(process.cwd(), candidate);

  if (!fs.existsSync(resolved)) {
    console.error(`Recording not found: ${resolved}`);
    process.exit(1);
  }

  return resolved;
}

function parseJsonl(filePath: string): RecordEvent[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const events: RecordEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as RecordEvent);
    } catch {
      console.warn("Skipping invalid JSONL line");
    }
  }
  return events;
}

function isLikelyStaticUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("linkedin.com")) return false;
    // Skip auth walls / transient challenge URLs
    if (/login|checkpoint|challenge|authwall/i.test(u.pathname + u.search)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function meaningfulClick(ev: RecordEvent): boolean {
  if (ev.type !== "click") return false;
  const text = (ev.text || ev.ariaName || "").trim();
  const hint = (ev.selectorHint || "").trim();
  // Skip empty / pure layout noise when possible
  if (!text && !hint && !ev.role && !ev.id) return false;
  if (/^(html|body|main)$/i.test(ev.tag || "")) return false;
  return true;
}

function lastFillValueBefore(
  events: RecordEvent[],
  index: number,
  matcher: (ev: RecordEvent) => boolean,
): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "input" || ev.type === "change") {
      if (ev.redacted) continue;
      if (typeof ev.value === "string" && matcher(ev)) {
        return ev.value;
      }
    }
    // Stop at navigation boundaries
    if (ev.type === "navigation" || ev.type === "start_url") break;
  }
  return undefined;
}

function eventsToSteps(events: RecordEvent[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const seenGoto = new Set<string>();

  // Prefer explicit start URLs from recording_start
  const start = events.find((e) => e.type === "recording_start");
  if (start?.startUrls && Array.isArray(start.startUrls)) {
    for (const url of start.startUrls) {
      if (typeof url === "string" && isLikelyStaticUrl(url) && !seenGoto.has(url)) {
        seenGoto.add(url);
        steps.push({
          kind: "goto",
          url,
          comment: "Start URL from recording session",
        });
      }
    }
  }

  for (const ev of events) {
    if (ev.type === "start_url" && ev.url && isLikelyStaticUrl(ev.url)) {
      if (!seenGoto.has(ev.url)) {
        seenGoto.add(ev.url);
        steps.push({
          kind: "goto",
          url: ev.url,
          comment: "Opened at recording start",
        });
      }
    }
  }

  let lastNav: string | undefined;
  events.forEach((ev, index) => {
    if (ev.type === "navigation" && ev.url && isLikelyStaticUrl(ev.url)) {
      // Only emit navigations that look like intentional page changes
      // (not every SPA fragment). Prefer path-level uniqueness.
      const key = ev.url.split("?")[0]!;
      if (key !== lastNav && !seenGoto.has(ev.url)) {
        // Avoid flooding: only if path differs from previous
        const prevPath = lastNav?.split("?")[0];
        if (key !== prevPath) {
          steps.push({
            kind: "goto",
            url: ev.url,
            comment:
              "Recorded navigation — may be SPA redirect; review before relying on it",
          });
          seenGoto.add(ev.url);
        }
      }
      lastNav = ev.url;
      return;
    }

    if (meaningfulClick(ev)) {
      const name = (ev.ariaName || ev.text || "").trim() || undefined;
      const fragile = !ev.role && !name && Boolean(ev.selectorHint);
      steps.push({
        kind: "click",
        role: ev.role || undefined,
        name,
        selectorHint: ev.selectorHint,
        text: ev.text,
        fragile,
        comment: `Recorded click @ ${ev.ts}${ev.url ? ` on ${ev.url}` : ""}`,
      });
      return;
    }

    if (
      (ev.type === "change" || ev.type === "input") &&
      typeof ev.value === "string" &&
      !ev.redacted &&
      ev.value.length > 0
    ) {
      // Prefer emitting on change (committed value); skip high-frequency input
      if (ev.type === "input") return;

      const name = (ev.ariaName || ev.text || ev.name || "").trim() || undefined;
      steps.push({
        kind: "fill",
        role: ev.role || undefined,
        name,
        selectorHint: ev.selectorHint,
        value: ev.value,
        fragile: !name && Boolean(ev.selectorHint),
        comment: `Recorded fill @ ${ev.ts}`,
      });
      return;
    }

    if (ev.type === "keydown" && ev.key === "Enter") {
      const fill =
        typeof ev.value === "string"
          ? ev.value
          : lastFillValueBefore(events, index, () => true);
      if (fill && !ev.redacted) {
        const name =
          (ev.ariaName || ev.text || ev.name || "").trim() || undefined;
        steps.push({
          kind: "fill",
          role: ev.role || undefined,
          name,
          selectorHint: ev.selectorHint,
          value: fill,
          fragile: !name && Boolean(ev.selectorHint),
          comment: `Value before Enter @ ${ev.ts}`,
        });
      }
      steps.push({
        kind: "press",
        key: "Enter",
        comment: `Recorded Enter @ ${ev.ts}`,
      });
    }
  });

  return coalesceSteps(steps);
}

/** Drop duplicate consecutive identical steps. */
function coalesceSteps(steps: ReplayStep[]): ReplayStep[] {
  const out: ReplayStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (prev && JSON.stringify(prev) === JSON.stringify(step)) continue;
    // Prefer role/name click over immediate duplicate with only selectorHint
    if (
      prev?.kind === "click" &&
      step.kind === "click" &&
      prev.name &&
      step.name === prev.name
    ) {
      continue;
    }
    out.push(step);
  }
  return out;
}

function emitStepCode(step: ReplayStep, index: number): string {
  const lines: string[] = [];
  if (step.comment) {
    lines.push(`  // ${step.comment}`);
  }
  if ("fragile" in step && step.fragile) {
    lines.push(
      "  // FRAGILE: CSS/class selectorHint — LinkedIn DOM changes often; prefer role+name",
    );
  }

  switch (step.kind) {
    case "goto":
      lines.push(`  console.log("Step ${index + 1}: goto ${step.url}");`);
      lines.push(
        `  await page.goto("${escapeTsString(step.url)}", { waitUntil: "domcontentloaded", timeout: 60_000 });`,
      );
      lines.push("  await settle(page);");
      break;
    case "click": {
      lines.push(
        `  console.log("Step ${index + 1}: click ${escapeTsString(step.name || step.selectorHint || step.text || "element")}");`,
      );
      if (step.role && step.name) {
        lines.push(
          `  await page.getByRole("${escapeTsString(step.role)}" as Parameters<Page["getByRole"]>[0], { name: ${JSON.stringify(step.name)} }).first().click({ timeout: 15_000 });`,
        );
      } else if (step.name) {
        lines.push(
          `  await page.getByRole("button", { name: ${JSON.stringify(step.name)} }).or(page.getByRole("link", { name: ${JSON.stringify(step.name)} })).or(page.getByText(${JSON.stringify(step.name)}, { exact: false })).first().click({ timeout: 15_000 });`,
        );
      } else if (step.selectorHint) {
        lines.push(
          `  await page.locator(${JSON.stringify(step.selectorHint)}).first().click({ timeout: 15_000 });`,
        );
      } else {
        lines.push(
          `  // Skipped: insufficient selector data for click (text=${JSON.stringify(step.text ?? "")})`,
        );
      }
      lines.push("  await settle(page);");
      break;
    }
    case "fill": {
      lines.push(
        `  console.log("Step ${index + 1}: fill ${escapeTsString(step.name || step.selectorHint || "field")}");`,
      );
      const valueLit = JSON.stringify(step.value);
      if (step.name) {
        lines.push(
          `  await page.getByRole("textbox", { name: ${JSON.stringify(step.name)} }).or(page.getByLabel(${JSON.stringify(step.name)})).or(page.getByPlaceholder(${JSON.stringify(step.name)})).first().fill(${valueLit}, { timeout: 15_000 });`,
        );
      } else if (step.selectorHint) {
        lines.push(
          `  await page.locator(${JSON.stringify(step.selectorHint)}).first().fill(${valueLit}, { timeout: 15_000 });`,
        );
      } else {
        lines.push(
          `  // Skipped: insufficient selector data for fill value=${valueLit}`,
        );
      }
      lines.push("  await settle(page);");
      break;
    }
    case "press":
      lines.push(`  console.log("Step ${index + 1}: press ${step.key}");`);
      lines.push(`  await page.keyboard.press("${escapeTsString(step.key)}");`);
      lines.push("  await settle(page);");
      break;
  }

  return lines.join("\n");
}

function generateSource(
  recordingPath: string,
  steps: ReplayStep[],
): string {
  const relRecording = path
    .relative(projectRoot, recordingPath)
    .replace(/\\/g, "/");
  const stepBlocks = steps.map((s, i) => emitStepCode(s, i)).join("\n\n");

  return `/**
 * AUTO-GENERATED from recording — do not treat as production-perfect.
 * Source: ${relRecording}
 * Generated: ${new Date().toISOString()}
 *
 * Review fragile selectors before running without DRY_RUN.
 * Env:
 *   DRY_RUN=true     — log steps only (default true)
 *   STEP_DELAY_MS    — delay between steps (default 1500)
 *   HEADLESS=true    — optional
 */
import "dotenv/config";
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import {
  LINKEDIN_STORAGE_STATE,
  LINKEDIN_USER_DATA_DIR,
  applyStorageStateFile,
  linkedInContextOptions,
  looksLikeLoginOrChallenge,
  verifyFeedLoads,
} from "../../lib/auth.js";

function isDryRun(): boolean {
  const v = process.env.DRY_RUN;
  if (v === undefined || v === "") return true;
  return v === "true" || v === "1";
}

function stepDelayMs(): number {
  const n = Number(process.env.STEP_DELAY_MS ?? "1500");
  return Number.isFinite(n) && n >= 0 ? n : 1500;
}

function isHeadless(): boolean {
  return process.env.HEADLESS === "true" || process.env.HEADLESS === "1";
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(stepDelayMs());
}

async function main(): Promise<void> {
  if (!fs.existsSync(LINKEDIN_STORAGE_STATE)) {
    throw new Error(
      "Missing auth/linkedin.json — run npm run auth:linkedin first.",
    );
  }

  const dryRun = isDryRun();
  const headless = isHeadless();
  console.log(
    dryRun
      ? "DRY_RUN=true — will navigate/auth-check and print steps without replaying clicks/fills."
      : "DRY_RUN=false — replaying recorded actions (review selectors first).",
  );

  fs.mkdirSync(LINKEDIN_USER_DATA_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(
    LINKEDIN_USER_DATA_DIR,
    {
      ...linkedInContextOptions(headless),
      acceptDownloads: true,
    },
  );

  try {
    await applyStorageStateFile(context);
    const page = context.pages()[0] ?? (await context.newPage());

    const auth = await verifyFeedLoads(page, context);
    if (!auth.ok || looksLikeLoginOrChallenge(auth.url)) {
      throw new Error(
        \`Not authenticated (url=\${auth.url}). Run npm run auth:linkedin.\`,
      );
    }

    const steps: Array<() => Promise<void>> = [
${steps
  .map((step, i) => {
    const body = emitStepCode(step, i)
      .split("\n")
      .map((l) => (l ? `      ${l}` : l))
      .join("\n");
    if (step.kind === "goto") {
      return `      async () => {\n${body}\n      }`;
    }
    // Non-navigation steps skipped in dry-run
    return `      async () => {
        if (dryRun) {
          console.log("[dry-run] skip interaction step ${i + 1}: ${step.kind}");
          return;
        }
${body}
      }`;
  })
  .join(",\n")}
    ];

    for (const step of steps) {
      await step();
    }

    console.log(dryRun ? "Dry-run finished." : "Replay finished.");
  } finally {
    await context.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
`;
}

// Fix: generateSource currently double-emits poorly. Rewrite more cleanly.
function generateSourceClean(
  recordingPath: string,
  steps: ReplayStep[],
): string {
  const relRecording = path
    .relative(projectRoot, recordingPath)
    .replace(/\\/g, "/");

  const actionBodies = steps
    .map((step, i) => {
      const inner = emitStepCode(step, i);
      const indented = inner
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      if (step.kind === "goto") {
        return `  // --- step ${i + 1} ---\n${indented}`;
      }
      return `  // --- step ${i + 1} ---\n  if (!dryRun) {\n${indented
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}\n  } else {\n    console.log("[dry-run] skip step ${i + 1}: ${step.kind}");\n  }`;
    })
    .join("\n\n");

  return `/**
 * AUTO-GENERATED from recording — review before real runs.
 * Source: ${relRecording}
 * Generated: ${new Date().toISOString()}
 *
 * Env:
 *   DRY_RUN=true     — log / navigate only; skip clicks & fills (default true)
 *   STEP_DELAY_MS    — delay between steps (default 1500)
 *   HEADLESS=true    — optional
 */
import "dotenv/config";
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import {
  LINKEDIN_STORAGE_STATE,
  LINKEDIN_USER_DATA_DIR,
  applyStorageStateFile,
  linkedInContextOptions,
  looksLikeLoginOrChallenge,
  verifyFeedLoads,
} from "../../lib/auth.js";

function isDryRun(): boolean {
  const v = process.env.DRY_RUN;
  if (v === undefined || v === "") return true;
  return v === "true" || v === "1";
}

function stepDelayMs(): number {
  const n = Number(process.env.STEP_DELAY_MS ?? "1500");
  return Number.isFinite(n) && n >= 0 ? n : 1500;
}

function isHeadless(): boolean {
  return process.env.HEADLESS === "true" || process.env.HEADLESS === "1";
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(stepDelayMs());
}

async function main(): Promise<void> {
  if (!fs.existsSync(LINKEDIN_STORAGE_STATE)) {
    throw new Error(
      "Missing auth/linkedin.json — run npm run auth:linkedin first.",
    );
  }

  const dryRun = isDryRun();
  const headless = isHeadless();
  console.log(
    dryRun
      ? "DRY_RUN=true — navigations run; clicks/fills are skipped."
      : "DRY_RUN=false — replaying recorded actions.",
  );

  fs.mkdirSync(LINKEDIN_USER_DATA_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(
    LINKEDIN_USER_DATA_DIR,
    {
      ...linkedInContextOptions(headless),
      acceptDownloads: true,
    },
  );

  try {
    await applyStorageStateFile(context);
    const page = context.pages()[0] ?? (await context.newPage());

    const auth = await verifyFeedLoads(page, context);
    if (!auth.ok || looksLikeLoginOrChallenge(auth.url)) {
      throw new Error(
        \`Not authenticated (url=\${auth.url}). Run npm run auth:linkedin.\`,
      );
    }

${actionBodies}

    console.log(dryRun ? "Dry-run finished." : "Replay finished.");
  } finally {
    await context.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
`;
}

function outputFilename(recordingPath: string): string {
  const base = path.basename(recordingPath, path.extname(recordingPath));
  return `from-${base}.ts`;
}

async function main(): Promise<void> {
  const recordingPath = resolveRecordingPath();
  const events = parseJsonl(recordingPath);
  const steps = eventsToSteps(events);

  if (steps.length === 0) {
    console.warn(
      "No replayable steps found in recording (only auth/session noise?). Generating a stub that opens start URLs if any.",
    );
  }

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const outPath = path.join(GENERATED_DIR, outputFilename(recordingPath));
  const source = generateSourceClean(recordingPath, steps);
  fs.writeFileSync(outPath, source, "utf8");

  const relOut = path.relative(process.cwd(), outPath);
  console.log(`\nGenerated workflow → ${relOut}`);
  console.log(`Steps: ${steps.length}`);
  console.log("\nRun (dry-run, default):");
  console.log(`  npx tsx ${relOut.replace(/\\/g, "/")}`);
  console.log("\nRun for real:");
  console.log(`  $env:DRY_RUN="false"; npx tsx ${relOut.replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
