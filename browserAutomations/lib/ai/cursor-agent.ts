/**
 * Cursor CLI helper for content generation.
 * Uses `agent -p --mode ask --output-format json` (non-interactive, read-only).
 *
 * Auth: CURSOR_API_KEY, or prior `agent login`.
 *
 * On Windows, invokes node.exe + index.js directly (avoids agent.cmd → PowerShell
 * re-parsing prompts with quotes/newlines).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveCursorApiKey(): string | undefined {
  return process.env.CURSOR_API_KEY?.trim() || undefined;
}

export function isCursorAvailable(): boolean {
  return Boolean(resolveAgentLaunch());
}

export function cursorModelId(): string {
  return (
    process.env.CONTENT_CURSOR_MODEL?.trim() ||
    process.env.CURSOR_MODEL?.trim() ||
    "composer-2.5"
  );
}

function isTransientCursorError(message: string): boolean {
  return /Failed to reach the Cursor API|Connection lost|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|EAI_AGAIN|Failed to load models/i.test(
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Isolated empty cwd so ask-mode does not wander the real repo. */
function resolveCursorWorkspace(): string {
  const explicit = process.env.CONTENT_CURSOR_WORKSPACE?.trim();
  if (explicit) {
    fs.mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  const dir = path.join(os.tmpdir(), "lanatus-content-cursor-workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

type AgentLaunch =
  | { kind: "node"; node: string; script: string }
  | { kind: "bin"; bin: string };

function parseVersionSortKey(name: string): number {
  const datePart = name.split("-")[0] ?? "";
  const parts = datePart.split(".");
  if (parts.length !== 3) return 0;
  const year = parts[0]!;
  const month = parts[1]!.padStart(2, "0");
  const day = parts[2]!.padStart(2, "0");
  return Number(year + month + day);
}

function resolveFromInstallRoot(root: string): AgentLaunch | undefined {
  const localNode = path.join(root, "node.exe");
  const localIndex = path.join(root, "index.js");
  if (fs.existsSync(localNode) && fs.existsSync(localIndex)) {
    return { kind: "node", node: localNode, script: localIndex };
  }

  const versionsDir = path.join(root, "versions");
  if (!fs.existsSync(versionsDir)) return undefined;

  const versions = fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) =>
      /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i.test(name),
    )
    .sort((a, b) => parseVersionSortKey(b) - parseVersionSortKey(a));

  for (const ver of versions) {
    const node = path.join(versionsDir, ver, "node.exe");
    const script = path.join(versionsDir, ver, "index.js");
    if (fs.existsSync(node) && fs.existsSync(script)) {
      return { kind: "node", node, script };
    }
    // non-Windows: node may be on PATH, script still versioned
    if (fs.existsSync(script)) {
      return { kind: "node", node: "node", script };
    }
  }
  return undefined;
}

function resolveAgentLaunch(): AgentLaunch | undefined {
  const explicit = process.env.CONTENT_CURSOR_CLI?.trim();
  if (explicit && fs.existsSync(explicit)) {
    if (explicit.endsWith(".js")) {
      return { kind: "node", node: "node", script: explicit };
    }
    return { kind: "bin", bin: explicit };
  }

  const roots = [
    path.join(process.env.LOCALAPPDATA ?? "", "cursor-agent"),
    path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? "",
      ".local",
      "share",
      "cursor-agent",
    ),
  ];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const launch = resolveFromInstallRoot(root);
    if (launch) return launch;
  }

  // Last resort: PATH binary (may break long prompts on Windows via .cmd)
  return {
    kind: "bin",
    bin: process.platform === "win32" ? "agent.cmd" : "agent",
  };
}

type AgentPrintJson = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
};

function extractAgentResult(stdout: string): string {
  const trimmed = stdout.trim();
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as AgentPrintJson;
      if (typeof obj.result === "string") {
        if (obj.is_error) {
          throw new Error(
            `Cursor CLI error result: ${obj.result.slice(0, 300)}`,
          );
        }
        return obj.result.trim();
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Cursor CLI error")) {
        throw err;
      }
    }
  }
  try {
    const obj = JSON.parse(trimmed) as AgentPrintJson;
    if (typeof obj.result === "string") return obj.result.trim();
  } catch {
    // fall through — treat stdout as plain text
  }
  return trimmed;
}

function runAgentCli(args: string[]): Promise<string> {
  const launch = resolveAgentLaunch();
  if (!launch) {
    throw new Error(
      "Cursor CLI not found. Install Cursor Agent CLI, or set CONTENT_CURSOR_CLI.",
    );
  }

  const timeoutMs = Number(process.env.CONTENT_CURSOR_TIMEOUT_MS ?? 180_000);
  const apiKey = resolveCursorApiKey();
  const cwd = resolveCursorWorkspace();
  const env = {
    ...process.env,
    ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}),
  };

  return runAgentCliWithRetry(launch, args, timeoutMs, cwd, env);
}

async function runAgentCliWithRetry(
  launch: AgentLaunch,
  args: string[],
  timeoutMs: number,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const maxAttempts = Math.max(
    1,
    Number(process.env.CONTENT_CURSOR_RETRIES ?? 4),
  );
  const baseMs = Math.max(
    1000,
    Number(process.env.CONTENT_CURSOR_RETRY_MS ?? 8000),
  );
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runAgentCliOnce(launch, args, timeoutMs, cwd, env);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!isTransientCursorError(lastErr.message) || attempt === maxAttempts) {
        throw lastErr;
      }
      const wait = baseMs * attempt;
      console.warn(
        `[content] Cursor API unreachable (attempt ${attempt}/${maxAttempts}). Retrying in ${Math.round(wait / 1000)}s…`,
      );
      await sleep(wait);
    }
  }
  throw lastErr ?? new Error("Cursor CLI failed");
}

function runAgentCliOnce(
  launch: AgentLaunch,
  args: string[],
  timeoutMs: number,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const spawnCmd =
    launch.kind === "node"
      ? { command: launch.node, argv: [launch.script, ...args], shell: false }
      : {
          command: launch.bin,
          argv: args,
          shell: process.platform === "win32",
        };

  return new Promise((resolve, reject) => {
    const child = spawn(spawnCmd.command, spawnCmd.argv, {
      cwd,
      env,
      windowsHide: true,
      shell: spawnCmd.shell,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Cursor CLI timed out after ${timeoutMs}ms. Increase CONTENT_CURSOR_TIMEOUT_MS if needed.`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to start Cursor CLI (${spawnCmd.command}): ${err.message}. Is \`agent\` installed?`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Cursor CLI exited ${code}: ${(stderr || stdout).trim().slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        const text = extractAgentResult(stdout);
        if (!text) {
          reject(
            new Error(
              `Cursor CLI returned empty result. stderr=${stderr.trim().slice(0, 300)}`,
            ),
          );
          return;
        }
        resolve(text);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * One-shot Cursor CLI prompt (print + ask = text out, no file edits).
 * Uses --output-format json and returns the envelope `result` string.
 */
export async function cursorPrompt(message: string): Promise<string> {
  const model = cursorModelId();
  const workspace = resolveCursorWorkspace();
  const args = [
    "-p",
    "--mode",
    "ask",
    "--output-format",
    "json",
    "--trust",
    "--workspace",
    workspace,
  ];
  if (model) {
    args.push("--model", model);
  }
  args.push(message);

  console.log(
    `[content] Cursor CLI → agent -p --mode ask --output-format json` +
      `${model ? ` --model ${model}` : ""}…`,
  );
  return runAgentCli(args);
}

function parseJsonLoose<T>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  return JSON.parse(text) as T;
}

function assertContentPayload(raw: string, parsed: unknown): void {
  const preview = raw.slice(0, 120).replace(/\s+/g, " ");
  if (/^(Ready\.|Understood\.|Sure[,.]|I'll )/i.test(raw.trim())) {
    throw new Error(
      `Cursor returned a preamble instead of JSON. Preview: ${preview}`,
    );
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "ok" in parsed &&
    (parsed as { ok?: boolean }).ok === false
  ) {
    throw new Error(
      `Cursor returned error payload instead of content. Preview: ${preview}`,
    );
  }
}

/** Ask Cursor CLI for a JSON object. */
export async function cursorPromptJson<T>(message: string): Promise<T> {
  // Avoid "task/payload" wording — some models treat that as a protocol and reply
  // with Ready / missing_task_payload instead of generating content.
  const raw = await cursorPrompt(
    [
      "You are a JSON generator. This message is complete — answer now.",
      "Do not explore files. Do not ask questions. Do not say Ready or Understood.",
      "Your entire reply must be one JSON object (double-quoted keys/strings).",
      "First character { — last character }.",
      "",
      message,
    ].join("\n"),
  );
  try {
    const parsed = parseJsonLoose<T>(raw);
    assertContentPayload(raw, parsed);
    return parsed;
  } catch (err) {
    throw new Error(
      `Failed to parse Cursor JSON: ${
        err instanceof Error ? err.message : String(err)
      }. Preview: ${raw.slice(0, 180)}`,
    );
  }
}
