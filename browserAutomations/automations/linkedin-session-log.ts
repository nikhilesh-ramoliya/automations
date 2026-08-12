import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Download, type Page } from "playwright";
import {
  AUTH_DIR,
  LINKEDIN_FEED_URL,
  LINKEDIN_STORAGE_STATE,
  LINKEDIN_USER_DATA_DIR,
  applyStorageStateFile,
  contextHasLiAt,
  linkedInContextOptions,
  looksLikeLoginOrChallenge,
  verifyFeedLoads,
} from "../lib/auth.js";
import {
  acquireLinkedInJobLock,
  releaseLinkedInJobLock,
} from "../lib/linkedin-safety.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOGS_DIR = path.join(projectRoot, "logs");

type SessionEvent = {
  ts: string;
  type: string;
  [key: string]: unknown;
};

type DomEventPayload = {
  type: "click" | "input" | "change" | "submit" | "keydown";
  url?: string;
  tag?: string;
  id?: string;
  name?: string;
  role?: string;
  typeAttr?: string;
  text?: string;
  selectorHint?: string;
  value?: string;
  key?: string;
  redacted?: boolean;
};

function timestampForFilename(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function ensureAuthExists(): void {
  if (!fs.existsSync(LINKEDIN_STORAGE_STATE)) {
    console.error(
      `Missing LinkedIn auth state: ${path.relative(process.cwd(), LINKEDIN_STORAGE_STATE)}\n` +
        "Run `npm run auth:linkedin` first to save a session.",
    );
    process.exit(1);
  }
}

function createLogWriter(logPath: string): {
  log: (event: SessionEvent) => void;
  flush: () => void;
  close: () => Promise<void>;
} {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  const log = (event: SessionEvent) => {
    const line = JSON.stringify(event);
    stream.write(line + "\n");
    const summary =
      event.type === "navigation"
        ? `→ ${event.url}`
        : event.type === "click"
          ? `click ${event.selectorHint ?? event.tag ?? ""} ${(event.text as string | undefined)?.slice(0, 40) ?? ""}`.trim()
          : event.type === "input" || event.type === "change"
            ? `${event.type} ${event.selectorHint ?? event.name ?? event.tag ?? ""} value=${event.redacted ? "[REDACTED]" : JSON.stringify(String(event.value ?? "").slice(0, 80))}`
            : event.type === "keydown"
              ? `key ${event.key} on ${event.selectorHint ?? event.tag ?? ""}`
              : event.type === "download"
                ? `download ${event.suggestedFilename ?? event.url ?? ""}`
                : event.type === "submit"
                  ? `submit ${event.selectorHint ?? event.tag ?? ""}`
                  : event.type;
    console.log(`[${event.ts.slice(11, 19)}] ${summary}`);
  };

  return {
    log,
    flush: () => {
      stream.cork();
      stream.uncork();
    },
    close: () =>
      new Promise<void>((resolve) => {
        stream.end(() => resolve());
      }),
  };
}

async function waitForEnterOrClose(
  message: string,
  closedPromise: Promise<void>,
): Promise<"enter" | "closed"> {
  if (!process.stdin.isTTY) {
    console.log(`${message}\n(No TTY — close the browser window to end the session.)`);
    await closedPromise;
    return "closed";
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const enterPromise = new Promise<"enter">((resolve) => {
    rl.question(`${message}\nPress Enter here to end the session… `, () => {
      resolve("enter");
    });
  });

  const result = await Promise.race([
    enterPromise,
    closedPromise.then(() => "closed" as const),
  ]);

  rl.close();
  return result;
}

function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Background / non-interactive: auto-save if we later detect login recovery
    return Promise.resolve(true);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} [Y/n] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

function attachPageListeners(
  page: Page,
  log: (event: SessionEvent) => void,
): void {
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    log({
      ts: new Date().toISOString(),
      type: "navigation",
      url: frame.url(),
    });
  });

  page.on("download", async (download: Download) => {
    log({
      ts: new Date().toISOString(),
      type: "download",
      url: download.url(),
      suggestedFilename: download.suggestedFilename(),
    });
  });
}

async function installDomLogging(
  context: BrowserContext,
  log: (event: SessionEvent) => void,
): Promise<void> {
  await context.exposeFunction(
    "__sessionLog",
    (payload: DomEventPayload) => {
      log({
        ts: new Date().toISOString(),
        ...payload,
      });
    },
  );

  await context.addInitScript(() => {
    const MAX_TEXT = 80;
    const MAX_VALUE = 200;

    function clip(s: string, n: number): string {
      const t = s.replace(/\s+/g, " ").trim();
      return t.length > n ? t.slice(0, n) + "…" : t;
    }

    function isPassword(el: Element): boolean {
      if (!(el instanceof HTMLInputElement)) return false;
      return el.type === "password";
    }

    function selectorHint(el: Element): string {
      const parts: string[] = [el.tagName.toLowerCase()];
      if (el.id) parts.push(`#${CSS.escape(el.id)}`);
      const cls =
        el instanceof HTMLElement && el.className && typeof el.className === "string"
          ? el.className
              .trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((c) => `.${CSS.escape(c)}`)
              .join("")
          : "";
      if (cls) parts.push(cls);
      const name = el.getAttribute("name");
      if (name) parts.push(`[name="${name}"]`);
      const aria = el.getAttribute("aria-label");
      if (aria) parts.push(`[aria-label="${clip(aria, 40)}"]`);
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) parts.push(`[placeholder="${clip(placeholder, 40)}"]`);
      return parts.join("");
    }

    function describe(el: Element | null) {
      if (!el || !(el instanceof Element)) return {};
      const text =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.getAttribute("name") ||
            ""
          : clip(el.textContent || "", MAX_TEXT);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        name: el.getAttribute("name") || undefined,
        role: el.getAttribute("role") || undefined,
        typeAttr:
          el instanceof HTMLInputElement || el instanceof HTMLButtonElement
            ? el.type
            : undefined,
        text: text ? clip(text, MAX_TEXT) : undefined,
        selectorHint: selectorHint(el),
      };
    }

    function send(payload: Record<string, unknown>) {
      try {
        const w = window as Window & {
          __sessionLog?: (p: Record<string, unknown>) => void;
        };
        w.__sessionLog?.({
          url: location.href,
          ...payload,
        });
      } catch {
        // page may be navigating
      }
    }

    document.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        send({ type: "click", ...describe(t) });
      },
      true,
    );

    const onField = (type: "input" | "change") => (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) {
        return;
      }
      const redacted = isPassword(t);
      send({
        type,
        ...describe(t),
        value: redacted ? undefined : clip(String(t.value ?? ""), MAX_VALUE),
        redacted: redacted || undefined,
      });
    };

    document.addEventListener("input", onField("input"), true);
    document.addEventListener("change", onField("change"), true);

    document.addEventListener(
      "submit",
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        send({ type: "submit", ...describe(t) });
      },
      true,
    );

    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter") return;
        const t = e.target;
        if (!(t instanceof Element)) return;
        const looksSearch =
          t instanceof HTMLInputElement &&
          (t.type === "search" ||
            /search/i.test(t.name || "") ||
            /search/i.test(t.getAttribute("aria-label") || "") ||
            /search/i.test(t.getAttribute("placeholder") || "") ||
            /search/i.test(t.id || ""));
        if (
          looksSearch ||
          t instanceof HTMLInputElement ||
          t instanceof HTMLTextAreaElement
        ) {
          const redacted = isPassword(t);
          send({
            type: "keydown",
            key: "Enter",
            ...describe(t),
            value:
              redacted || !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
                ? undefined
                : clip(String(t.value ?? ""), MAX_VALUE),
            redacted: redacted || undefined,
          });
        }
      },
      true,
    );
  });
}

/**
 * Fail fast when redirected to login; optionally let the user log in manually
 * in this same window and refresh storage state.
 */
async function handleUnauthenticatedOrRecover(
  page: Page,
  context: BrowserContext,
  log: (event: SessionEvent) => void,
): Promise<boolean> {
  const url = page.url();
  if (!looksLikeLoginOrChallenge(url) && (await contextHasLiAt(context))) {
    return true;
  }

  console.error(
    "\nSaved LinkedIn session is invalid or expired (redirected to login/checkpoint).\n" +
      `Current URL: ${url}\n` +
      "You can log in manually in this browser window, or run `npm run auth:linkedin`.\n",
  );

  log({
    ts: new Date().toISOString(),
    type: "auth_invalid",
    url,
  });

  const recover = await askYesNo(
    "Log in manually here and save a fresh session when done?",
  );

  if (!recover) {
    console.error(
      "Aborting. Run `npm run auth:linkedin` to capture a new session.",
    );
    return false;
  }

  console.log(
    "Complete login / 2FA in the browser. Waiting up to 10 minutes for feed + li_at…",
  );

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const check = await verifyFeedLoads(page, context).catch(() => ({
      ok: false,
      url: page.url(),
    }));
    if (check.ok && (await contextHasLiAt(context))) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      await context.storageState({ path: LINKEDIN_STORAGE_STATE });
      console.log(
        `Saved refreshed storage state → ${path.relative(process.cwd(), LINKEDIN_STORAGE_STATE)}`,
      );
      log({
        ts: new Date().toISOString(),
        type: "auth_recovered",
        url: check.url,
      });
      return true;
    }
    await page.waitForTimeout(2_000);
  }

  console.error(
    "Timed out waiting for manual login. Session not saved. Run `npm run auth:linkedin`.",
  );
  return false;
}

async function main(): Promise<void> {
  ensureAuthExists();

  const logPath = path.join(
    LOGS_DIR,
    `linkedin-session-${timestampForFilename()}.jsonl`,
  );
  const writer = createLogWriter(logPath);

  writer.log({
    ts: new Date().toISOString(),
    type: "session_start",
    storageState: path.relative(process.cwd(), LINKEDIN_STORAGE_STATE),
    userDataDir: path.relative(process.cwd(), LINKEDIN_USER_DATA_DIR),
    logFile: path.relative(process.cwd(), logPath),
  });

  console.log(`Logging to ${path.relative(process.cwd(), logPath)}`);
  console.log("Launching headed Chromium with persistent LinkedIn profile…");

  fs.mkdirSync(LINKEDIN_USER_DATA_DIR, { recursive: true });
  acquireLinkedInJobLock("session:linkedin");

  let context;
  try {
    context = await chromium.launchPersistentContext(
      LINKEDIN_USER_DATA_DIR,
      {
        ...linkedInContextOptions(false),
        acceptDownloads: true,
      },
    );
  } catch (err) {
    releaseLinkedInJobLock();
    const message = err instanceof Error ? err.message : String(err);
    if (/existing browser session|user data dir|SingletonLock|already in use/i.test(message)) {
      console.error(
        "LinkedIn profile is already in use. Close other jobs/windows, then retry.",
      );
      process.exit(1);
    }
    throw err;
  }

  const seeded = await applyStorageStateFile(context);
  if (seeded > 0) {
    console.log(`Applied ${seeded} cookies from storage state.`);
  }

  await installDomLogging(context, writer.log);

  const page = context.pages()[0] ?? (await context.newPage());
  attachPageListeners(page, writer.log);

  context.on("page", (p) => {
    attachPageListeners(p, writer.log);
    writer.log({
      ts: new Date().toISOString(),
      type: "page_opened",
      url: p.url(),
    });
  });

  let resolveClosed: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const checkAllClosed = () => {
    if (context.pages().length === 0) resolveClosed();
  };
  context.on("page", (p) => {
    p.on("close", checkAllClosed);
  });
  page.on("close", checkAllClosed);

  try {
    await page.goto(LINKEDIN_FEED_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  } catch (err) {
    console.warn(
      "Initial navigation timed out or failed; checking auth state…",
      err instanceof Error ? err.message : err,
    );
  }

  const authenticated = await handleUnauthenticatedOrRecover(
    page,
    context,
    writer.log,
  );

  if (!authenticated) {
    writer.log({
      ts: new Date().toISOString(),
      type: "session_end",
      reason: "auth_failed",
    });
    writer.flush();
    await writer.close();
    await context.close().catch(() => undefined);
    releaseLinkedInJobLock();
    process.exit(1);
  }

  console.log("Browser open. Search and click around — actions are logged.");
  const reason = await waitForEnterOrClose(
    "Interact in the browser window.",
    closedPromise,
  );

  writer.log({
    ts: new Date().toISOString(),
    type: "session_end",
    reason: reason === "enter" ? "user_enter" : "browser_closed",
  });
  writer.flush();
  await writer.close();

  console.log(
    `Session ended (${reason}). Logs saved → ${path.relative(process.cwd(), logPath)}`,
  );

  await context.close().catch(() => undefined);
  releaseLinkedInJobLock();
}

main().catch((err) => {
  releaseLinkedInJobLock();
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
