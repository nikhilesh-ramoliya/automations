import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./paths.js";

export type LogEvent = {
  ts: string;
  type: string;
  [key: string]: unknown;
};

export function timestampForFilename(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function jobLogPath(jobId: string, prefix?: string): string {
  const base = prefix ?? jobId;
  return path.join(LOGS_DIR, `${base}-${timestampForFilename()}.jsonl`);
}

export function healLogPath(jobId: string): string {
  return path.join(LOGS_DIR, `${jobId}-heal-${timestampForFilename()}.jsonl`);
}

export type LogWriter = {
  logPath: string;
  log: (event: LogEvent) => void;
  close: () => Promise<void>;
};

/**
 * Append-only JSONL logger with concise console lines.
 * Pass `formatConsole` to customize the detail shown after `type`.
 */
export function createJsonlLogger(
  logPath: string,
  formatConsole?: (event: LogEvent) => string,
): LogWriter {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  return {
    logPath,
    log: (event) => {
      stream.write(JSON.stringify(event) + "\n");
      const detail = formatConsole?.(event) ?? defaultConsoleDetail(event);
      console.log(
        `[${event.ts.slice(11, 19)}] ${event.type}${detail ? ` ${detail}` : ""}`,
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        stream.end(() => resolve());
      }),
  };
}

function defaultConsoleDetail(event: LogEvent): string {
  if (event.message) return String(event.message);
  if (event.count !== undefined) return `count=${event.count}`;
  if (event.url) return String(event.url);
  return "";
}
