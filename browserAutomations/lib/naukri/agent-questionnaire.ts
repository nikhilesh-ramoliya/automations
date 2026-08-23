/**
 * Fill Naukri in-app screening questions via Cursor Agent SDK + Playwright MCP.
 *
 * NAUKRI_QUESTIONNAIRE_MODE:
 * - scripted — selectors only
 * - agent — always Cursor SDK
 * - auto — scripted first; SDK if stalled / unanswered (default)
 */

import type { Page } from "playwright";
import path from "node:path";
import { Agent, CursorAgentError, JsonlLocalAgentStore } from "@cursor/sdk";
import {
  NAUKRI_STORAGE_STATE,
  NAUKRI_USER_DATA_DIR,
} from "../auth-naukri.js";
import { envBool, naukriResumePath } from "./env.js";
import { loadProfileAnswers } from "./questionnaire.js";

export type AgentQuestionnaireResult = {
  answered: number;
  submitted: boolean;
  detail: string;
  status: "ok" | "error" | "skipped";
};

function questionnaireMode(): "scripted" | "agent" | "auto" {
  const raw = (process.env.NAUKRI_QUESTIONNAIRE_MODE || "auto")
    .trim()
    .toLowerCase();
  if (raw === "agent" || raw === "sdk") return "agent";
  if (raw === "scripted" || raw === "selectors") return "scripted";
  return "auto";
}

export function naukriQuestionnaireMode(): "scripted" | "agent" | "auto" {
  return questionnaireMode();
}

export function shouldUseAgentQuestionnaire(scripted?: {
  answered: number;
  submitted: boolean;
  stalled?: boolean;
}): boolean {
  const mode = questionnaireMode();
  if (mode === "agent") return true;
  if (mode === "scripted") return false;
  if (!scripted) return false;
  return (
    scripted.stalled === true ||
    scripted.answered === 0 ||
    !scripted.submitted
  );
}

function buildProfileBlock(): string {
  const p = loadProfileAnswers();
  const resume = naukriResumePath();
  return [
    "Candidate profile (use these answers; do not invent conflicting values):",
    `- Notice period: ${p.noticePeriodDays} days`,
    `- Current CTC: ${p.currentCtcLpa} LPA`,
    `- Expected CTC: ${p.expectedCtcLpa} LPA`,
    `- Experience: ${p.experienceYears} years`,
    `- Relocate: ${p.relocate ? "Yes" : "No"}`,
    `- City: ${p.city}`,
    `- Serving notice: ${p.servingNotice ? "Yes" : "No"}`,
    `- Default Yes/No preference: ${p.defaultYes ? "Yes" : "No"}`,
    `- Default text: ${p.defaultText}`,
    resume
      ? `- Resume PDF path: ${resume}`
      : "- Resume: not configured (skip uploads if required)",
  ].join("\n");
}

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() || text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function cdpEndpointFromPage(page: Page): Promise<string | null> {
  try {
    const browser = page.context().browser();
    if (!browser) return null;
    // Playwright Browser exposes wsEndpoint(); cast for typings across versions
    const withWs = browser as { wsEndpoint?: () => string };
    return typeof withWs.wsEndpoint === "function" ? withWs.wsEndpoint() : null;
  } catch {
    return null;
  }
}

/**
 * Drive the Naukri apply chatbot with Cursor Agent + Playwright MCP.
 * Prefer attaching to the already-open apply page via CDP when possible.
 */
export async function fillNaukriQuestionnaireViaAgent(
  page: Page,
  opts: { dryRun: boolean; jobUrl: string },
): Promise<AgentQuestionnaireResult> {
  if (!envBool("NAUKRI_AGENT_QUESTIONNAIRE", true)) {
    return {
      answered: 0,
      submitted: false,
      detail: "agent_disabled",
      status: "skipped",
    };
  }

  const apiKey = process.env.CURSOR_API_KEY?.trim();
  const cdp = await cdpEndpointFromPage(page);
  const resume = naukriResumePath();

  const playwrightArgs = cdp
    ? ["-y", "@playwright/mcp@latest", "--cdp-endpoint", cdp]
    : [
        "-y",
        "@playwright/mcp@latest",
        "--storage-state",
        NAUKRI_STORAGE_STATE,
      ];

  const prompt = [
    "You are completing Naukri.com in-app job apply screening questions.",
    opts.dryRun
      ? "DRY RUN: answer visible questions but do NOT click a final irreversible submit if the UI clearly says the application will be sent. Prefer stopping after answering chatbot questions / clicking chatbot Save."
      : "LIVE: answer all screening questions and finish the apply if possible.",
    "",
    `Job URL (already open or navigate here if needed): ${opts.jobUrl}`,
    `Current page URL: ${page.url()}`,
    "",
    buildProfileBlock(),
    "",
    "UI notes for Naukri chatbot drawer:",
    "- Questions appear in a right-side drawer (.chatbot_Drawer).",
    "- Yes/No options use label.ssrc__label / input.ssrc__radio#Yes|#No.",
    "- After selecting an answer, click div.sendMsg (text Save) — it is NOT always a <button>.",
    "- Use a real click (not force-click hacks).",
    "- Continue until applied successfully, no more questions, or you are blocked (login/captcha).",
    resume ? `- If asked to upload resume/CV, upload: ${resume}` : "",
    "",
    "Return a single JSON object at the end:",
    '{ "status": "applied"|"answered"|"blocked"|"error", "answered": number, "submitted": boolean, "notes": string }',
  ]
    .filter(Boolean)
    .join("\n");

  console.log(
    `  [cursor-agent] Filling Naukri questionnaire (cdp=${cdp ? "attached" : "storage-state"}, dryRun=${opts.dryRun})…`,
  );

  try {
    await using agent = await Agent.create({
      ...(apiKey ? { apiKey } : {}),
      model: {
        id: process.env.NAUKRI_AGENT_MODEL?.trim() || "composer-2.5",
      },
      local: {
        cwd: process.cwd(),
        settingSources: [],
        // Node 20 has no node:sqlite — use JSONL store instead of default SQLite
        store: new JsonlLocalAgentStore(
          path.join(process.cwd(), "data", "naukri-agent-store"),
        ),
      },
      mcpServers: {
        playwright: {
          type: "stdio",
          command: "npx",
          args: playwrightArgs,
          cwd: process.cwd(),
          env: {
            PLAYWRIGHT_STORAGE_STATE: NAUKRI_STORAGE_STATE,
            PLAYWRIGHT_USER_DATA_DIR: NAUKRI_USER_DATA_DIR,
          },
        },
      },
    });

    const run = await agent.send(prompt);
    for await (const event of run.stream()) {
      const anyEvent = event as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (anyEvent.type === "assistant" && anyEvent.message?.content) {
        for (const block of anyEvent.message.content) {
          if (block.type === "text" && block.text?.trim()) {
            console.log(`  [agent] ${block.text.trim().slice(0, 200)}`);
          }
        }
      }
    }

    const result = await run.wait();
    if (result.status === "error") {
      return {
        answered: 0,
        submitted: false,
        detail: `agent_run_error:${result.error?.message || result.id}`,
        status: "error",
      };
    }

    const text = result.result ?? "";
    const parsed = extractJson(text);
    if (parsed) {
      const answered = Number(parsed.answered) || 0;
      const submitted = Boolean(parsed.submitted);
      const status = String(parsed.status || "answered");
      return {
        answered,
        submitted,
        detail: `agent:${status};answered=${answered};submitted=${submitted};${String(parsed.notes || "").slice(0, 120)}`,
        status: status === "error" ? "error" : "ok",
      };
    }

    return {
      answered: 0,
      submitted: false,
      detail: `agent_done_unparsed:${text.slice(0, 160)}`,
      status: "ok",
    };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      return {
        answered: 0,
        submitted: false,
        detail: `agent_startup_failed:${err.message}`,
        status: "error",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      answered: 0,
      submitted: false,
      detail: `agent_exception:${message}`,
      status: "error",
    };
  }
}
