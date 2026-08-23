/**
 * LinkedIn connection request (with optional note) for people without email.
 */

import type { Locator, Page } from "playwright";
import { humanBrowseProfile } from "../human-browse.js";
import {
  assertWithinCap,
  humanDelay,
  recordAction,
} from "../linkedin-safety.js";
import { assertNotLogin } from "./browser.js";

export type ConnectResult =
  | {
      ok: true;
      mode: "connected" | "note_sent" | "already_connected" | "pending" | "dry_run";
    }
  | { ok: false; error: string };

/**
 * Visible profile relationship chrome (does not click).
 * Does not open the More menu — Connect-under-More reports as `"none"`.
 */
export type ConnectionState = "pending" | "message" | "connect" | "none";

const NOTE_MAX = 280;

function truncateNote(body: string): string {
  const t = body.replace(/\s+/g, " ").trim();
  if (t.length <= NOTE_MAX) return t;
  return t.slice(0, NOTE_MAX - 1).trimEnd() + "…";
}

async function isVisibleLoose(locator: Locator): Promise<boolean> {
  const first = locator.first();
  if (await first.isVisible().catch(() => false)) return true;
  return first.isVisible({ timeout: 800 }).catch(() => false);
}

/** Profile identity + action row only — never sidebar "More profiles". */
export function profileIntro(page: Page): Locator {
  return page
    .locator(
      [
        '[data-view-name="profile-top-card"]',
        "section.artdeco-card.pv-top-card",
        ".pv-top-card",
        "main section",
      ].join(", "),
    )
    .first();
}

type IntroSignals = {
  degree: "1st" | "2nd" | "3rd" | "unknown";
  pending: boolean;
  connect: boolean;
  message: boolean;
  newConnection: boolean;
};

export async function readIntroSignals(page: Page): Promise<IntroSignals> {
  const intro = profileIntro(page);
  await intro.waitFor({ state: "visible", timeout: 8000 }).catch(() => undefined);

  return intro.evaluate((root) => {
    const el = root as HTMLElement;
    const text = (el.innerText || "").slice(0, 2500);
    const head = text.split("\n").slice(0, 12).join(" ");
    const buttons = Array.from(root.querySelectorAll("button, a")).map((el) =>
      ((el.getAttribute("aria-label") || "") + " " + (el.textContent || ""))
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    );

    const pending = buttons.some((b) => /\bpending\b/.test(b));
    const connect = buttons.some(
      (b) => /\bconnect\b/.test(b) && !/\bpending\b/.test(b) && !/\bmessage\b/.test(b),
    );
    const message = buttons.some((b) => /\bmessage\b/.test(b));

    let degree: IntroSignals["degree"] = "unknown";
    if (/(^|[^a-z0-9])1st([^a-z0-9]|$)/i.test(head)) degree = "1st";
    else if (/(^|[^a-z0-9])2nd([^a-z0-9]|$)/i.test(head)) degree = "2nd";
    else if (/(^|[^a-z0-9])3rd([^a-z0-9]|$)/i.test(head)) degree = "3rd";

    const newConnection = /is a new connection/i.test(text);
    return { degree, pending, connect, message, newConnection };
  });
}

export async function hasPendingInvite(page: Page): Promise<boolean> {
  const signals = await readIntroSignals(page).catch(() => null);
  return signals?.pending ?? false;
}

export async function isNonFirstDegree(page: Page): Promise<boolean> {
  const signals = await readIntroSignals(page).catch(() => null);
  return signals?.degree === "2nd" || signals?.degree === "3rd";
}

export async function hasConnectButton(page: Page): Promise<boolean> {
  const signals = await readIntroSignals(page).catch(() => null);
  return signals?.connect ?? false;
}

export async function hasMessageButton(page: Page): Promise<boolean> {
  const signals = await readIntroSignals(page).catch(() => null);
  return signals?.message ?? false;
}

/**
 * Detect relationship from the profile intro only.
 *
 * Accepted 1st-degree: "1st" and/or "is a new connection" + Message, no Pending.
 * InMail trap: 2nd/3rd + Message + Pending → pending (do not DM).
 */
export async function detectConnectionState(
  page: Page,
): Promise<ConnectionState> {
  const s = await readIntroSignals(page);
  if (s.pending) return "pending";
  if (s.degree === "1st" || s.newConnection) {
    if (s.message) return "message";
  }
  if (s.degree === "2nd" || s.degree === "3rd") {
    return s.connect ? "connect" : "pending";
  }
  if (s.connect) return "connect";
  if (s.message) return "message";
  return "none";
}

async function clickConnectEntry(
  page: Page,
): Promise<"connect" | "pending" | "message" | "none"> {
  const state = await detectConnectionState(page);
  if (state === "pending") return "pending";
  if (state === "message") return "message";

  const intro = profileIntro(page);
  const connect = intro
    .getByRole("button", { name: /^connect$/i })
    .or(intro.locator('button[aria-label*="Invite"][aria-label*="connect" i]'))
    .first();
  if (await connect.isVisible().catch(() => false)) {
    await humanDelay("click");
    await connect.click();
    return "connect";
  }

  const more = page
    .getByRole("button", { name: /^more$/i })
    .or(page.locator('button[aria-label="More actions"]'))
    .first();
  if (await more.isVisible().catch(() => false)) {
    await humanDelay("click");
    await more.click();
    await page.waitForTimeout(800);
    const item = page
      .getByRole("menuitem", { name: /^connect$/i })
      .or(page.getByRole("button", { name: /^connect$/i }))
      .first();
    if (await item.isVisible().catch(() => false)) {
      await item.click();
      return "connect";
    }
  }
  return "none";
}

/**
 * Visit profile and send a connection request (optional personalized note).
 * Scrolls + dwells before connecting (not click-immediately).
 */
export async function connectWithOptionalNote(
  page: Page,
  opts: {
    profileUrl: string;
    note?: string;
    dryRun: boolean;
    addNote: boolean;
  },
): Promise<ConnectResult> {
  assertWithinCap("connect", 1);

  await page.goto(opts.profileUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanDelay("nav");
  assertNotLogin(page, "linkedin connect");
  await humanBrowseProfile(page);
  recordAction("profile_view", 1);

  const entry = await clickConnectEntry(page);
  if (entry === "pending") {
    return { ok: true, mode: "pending" };
  }
  if (entry === "message") {
    return { ok: true, mode: "already_connected" };
  }
  if (entry === "none") {
    return { ok: false, error: "connect_button_not_found" };
  }

  await humanDelay("between_actions");

  const note = opts.note ? truncateNote(opts.note) : "";
  const addNoteBtn = page
    .getByRole("button", { name: /add a note/i })
    .or(page.getByRole("button", { name: /personalize/i }))
    .first();

  if (
    opts.addNote &&
    note &&
    (await addNoteBtn.isVisible().catch(() => false))
  ) {
    await humanDelay("click");
    await addNoteBtn.click();
    await humanDelay("idle_micro");
    const textarea = page
      .locator('textarea[name="message"], textarea#custom-message, textarea')
      .first();
    if (await textarea.isVisible().catch(() => false)) {
      await humanDelay("type_burst");
      await textarea.fill(note);
    }
  }

  if (opts.dryRun) {
    console.log(
      `[linkedin dry-run] Would connect ${opts.profileUrl}` +
        (note ? ` with note (${note.length} chars)` : " without note"),
    );
    await page.keyboard.press("Escape").catch(() => undefined);
    return { ok: true, mode: "dry_run" };
  }

  const send = page
    .getByRole("button", { name: /^(send|done|connect)$/i })
    .filter({ hasNotText: /cancel/i })
    .first();
  if (!(await send.isVisible().catch(() => false))) {
    return { ok: false, error: "send_invite_button_not_found" };
  }
  await humanDelay("invite_think");
  await send.click();
  recordAction("connect", 1);
  await humanDelay("between_actions");
  return {
    ok: true,
    mode: opts.addNote && note ? "note_sent" : "connected",
  };
}
