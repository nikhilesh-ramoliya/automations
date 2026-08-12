/**
 * LinkedIn connection request (with optional note) for people without email.
 */

import type { Page } from "playwright";
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

/** Detect Pending / Message / Connect on a profile without mutating UI. */
export async function detectConnectionState(
  page: Page,
): Promise<ConnectionState> {
  const pending = page.getByRole("button", { name: /^pending$/i }).first();
  if (await pending.isVisible().catch(() => false)) return "pending";

  const message = page
    .getByRole("button", { name: /^message$/i })
    .or(page.getByRole("link", { name: /^message$/i }))
    .first();
  if (await message.isVisible().catch(() => false)) {
    return "message";
  }

  const connect = page
    .getByRole("button", { name: /^connect$/i })
    .or(page.locator('button[aria-label*="Invite"][aria-label*="connect" i]'))
    .first();
  if (await connect.isVisible().catch(() => false)) {
    return "connect";
  }

  return "none";
}

async function clickConnectEntry(
  page: Page,
): Promise<"connect" | "pending" | "message" | "none"> {
  const pending = page.getByRole("button", { name: /^pending$/i }).first();
  if (await pending.isVisible().catch(() => false)) return "pending";

  const message = page
    .getByRole("button", { name: /^message$/i })
    .or(page.getByRole("link", { name: /^message$/i }))
    .first();
  if (await message.isVisible().catch(() => false)) {
    return "message";
  }

  const connect = page
    .getByRole("button", { name: /^connect$/i })
    .or(page.locator('button[aria-label*="Invite"][aria-label*="connect" i]'))
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
