/**
 * LinkedIn 1st-degree DM after an accepted connection (lead follow-up).
 */

import type { Locator, Page } from "playwright";
import { humanBrowseProfile } from "../human-browse.js";
import {
  assertWithinCap,
  humanDelay,
  recordAction,
} from "../linkedin-safety.js";
import { assertNotLogin } from "./browser.js";
import { detectConnectionState } from "./linkedin-connect.js";

export type MessageResult =
  | {
      ok: true;
      status: "pending" | "messaged" | "skipped";
      detail?: string;
      messagePreview?: string;
    }
  | { ok: false; error: string };

const MSG_MAX = 300;

export function truncateFollowupMessage(body: string): string {
  const t = body.replace(/\s+/g, " ").trim();
  if (t.length <= MSG_MAX) return t;
  return t.slice(0, MSG_MAX - 1).trimEnd() + "…";
}

async function findMessageEditor(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator(".msg-form__contenteditable[contenteditable='true']"),
    page.locator('div.msg-form__contenteditable[role="textbox"]'),
    page.locator('.msg-overlay-conversation-bubble div[contenteditable="true"]'),
    page.locator('div[role="textbox"][contenteditable="true"]'),
    page.locator('textarea[name="message"]'),
  ];
  for (const loc of candidates) {
    const first = loc.first();
    if (await first.isVisible({ timeout: 2500 }).catch(() => false)) {
      return first;
    }
  }
  return null;
}

async function findMessageSend(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator("button.msg-form__send-button"),
    page.getByRole("button", { name: /^send$/i }),
    page.locator('button[type="submit"]').filter({ hasText: /^send$/i }),
  ];
  for (const loc of candidates) {
    const first = loc.first();
    if (await first.isVisible().catch(() => false)) {
      return first;
    }
  }
  return null;
}

/**
 * Visit profile; if Message is available (accepted), type a short DM.
 * Dry-run types the message but does not click Send.
 */
export async function messageAcceptedConnection(
  page: Page,
  opts: {
    profileUrl: string;
    message: string;
    dryRun: boolean;
    /** When true, pending/connect → skipped (not_accepted) instead of pending. */
    onlyAccepted?: boolean;
  },
): Promise<MessageResult> {
  const text = truncateFollowupMessage(opts.message);
  if (!text) {
    return { ok: false, error: "empty_message" };
  }

  await page.goto(opts.profileUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanDelay("nav");
  assertNotLogin(page, "linkedin followup message");
  await humanBrowseProfile(page);
  recordAction("profile_view", 1);

  const state = await detectConnectionState(page);

  if (state === "pending") {
    if (opts.onlyAccepted) {
      return { ok: true, status: "skipped", detail: "not_accepted" };
    }
    return { ok: true, status: "pending", detail: "still_pending" };
  }

  if (state === "connect" || state === "none") {
    return {
      ok: true,
      status: "skipped",
      detail: state === "connect" ? "connect_still_available" : "no_message_button",
    };
  }

  // state === "message" — 1st degree / accepted
  assertWithinCap("message", 1);
  const messageBtn = page
    .getByRole("button", { name: /^message$/i })
    .or(page.getByRole("link", { name: /^message$/i }))
    .first();
  await humanDelay("click");
  await messageBtn.click();
  await humanDelay("type_burst");

  const editor = await findMessageEditor(page);
  if (!editor) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return { ok: false, error: "message_editor_not_found" };
  }

  await humanDelay("type_burst");
  await editor.click().catch(() => undefined);
  // Clear any draft remnant, then type like a human
  await editor.fill("").catch(() => undefined);
  await page.keyboard
    .type(text, { delay: 20 + Math.floor(Math.random() * 25) })
    .catch(async () => {
      await editor.fill(text).catch(() => undefined);
    });
  await humanDelay("invite_think", { minMs: 900 });

  if (opts.dryRun) {
    console.log(
      `[linkedin dry-run] Would message ${opts.profileUrl} (${text.length} chars)`,
    );
    await page.keyboard.press("Escape").catch(() => undefined);
    return {
      ok: true,
      status: "messaged",
      detail: "dry_run",
      messagePreview: text.slice(0, 120),
    };
  }

  const send = await findMessageSend(page);
  if (!send) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return { ok: false, error: "message_send_button_not_found" };
  }
  await humanDelay("click");
  await send.click();
  recordAction("message", 1);
  await humanDelay("between_actions");
  return {
    ok: true,
    status: "messaged",
    detail: "sent",
    messagePreview: text.slice(0, 120),
  };
}
