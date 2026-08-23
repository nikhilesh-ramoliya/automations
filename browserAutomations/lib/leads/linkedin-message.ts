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
import {
  detectConnectionState,
  hasPendingInvite,
  profileIntro,
  readIntroSignals,
} from "./linkedin-connect.js";

export type MessageResult =
  | {
      ok: true;
      status: "pending" | "messaged" | "skipped";
      detail?: string;
      messagePreview?: string;
    }
  | { ok: false; error: string };

const MSG_MAX = 300;
const QUICK_DELAY = { skipBurstCheck: true as const };

function logStep(quick: boolean | undefined, msg: string): void {
  if (quick) console.log(`    ${msg}`);
}

/** Close leftover chat overlays so they don't cover the next profile header. */
export async function closeMessageOverlays(page: Page): Promise<void> {
  const restore = page.getByRole("button", { name: /^restore$/i });
  if (await restore.isVisible().catch(() => false)) {
    await restore.click().catch(() => undefined);
    await page.waitForTimeout(300);
  }

  const closeBtns = page.locator(
    [
      '.msg-overlay-bubble-header button[aria-label*="Close" i]',
      '.msg-overlay-conversation-bubble button[aria-label*="Close" i]',
      'button[data-control-name="overlay.close_conversation_window"]',
      'button[aria-label*="Close your conversation" i]',
      'button[aria-label*="Close conversation" i]',
    ].join(", "),
  );

  for (let i = 0; i < 6; i++) {
    const btn = closeBtns.nth(i);
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }

  const bubbles = page.locator(".msg-overlay-conversation-bubble");
  const count = await bubbles.count().catch(() => 0);
  if (count > 0) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}

export function truncateFollowupMessage(body: string): string {
  const t = body
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length <= MSG_MAX) return t;
  return t.slice(0, MSG_MAX - 1).trimEnd() + "…";
}

/** Parse fsd_profile URN from profile page HTML. */
export function extractProfileUrn(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const patterns = [
      /urn:li:fsd_profile:([A-Za-z0-9_-]+)/,
      /"publicIdentifier":"[^"]+"[^}]*"entityUrn":"urn:li:fsd_profile:([A-Za-z0-9_-]+)"/,
      /profileUrn[%"=:]+([A-Za-z0-9_-]{20,})/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) return `urn:li:fsd_profile:${m[1]}`;
    }
    return null;
  });
}

async function findMessageEditor(
  page: Page,
  waitMs = 10_000,
): Promise<Locator | null> {
  const overlay = page.locator(
    ".msg-overlay-conversation-bubble, .msg-form, [data-view-name='message-overlay']",
  );
  const candidates = [
    overlay.locator(".msg-form__contenteditable[contenteditable='true']"),
    overlay.locator('div.msg-form__contenteditable'),
    overlay.locator('div[role="textbox"][contenteditable="true"]'),
    page.getByRole("textbox", { name: /write a message/i }),
    page.locator('[aria-label*="Write a message" i][contenteditable="true"]'),
    page.locator('[data-placeholder*="Write a message" i]'),
    page.locator(".msg-form__contenteditable[contenteditable='true']"),
    page.locator('.msg-overlay-conversation-bubble div[contenteditable="true"]'),
    page.locator(".msg-form div[contenteditable='true']"),
    page.locator('div[role="textbox"][contenteditable="true"]'),
    page.locator('textarea[name="message"]'),
  ];

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    for (const loc of candidates) {
      const first = loc.first();
      if (await first.isVisible().catch(() => false)) {
        return first;
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function findMessageSend(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator("button.msg-form__send-button:not([disabled])"),
    page.locator("button.msg-form__send-button"),
    page.getByRole("button", { name: /^send$/i }),
    page.locator('button[aria-label*="Send" i]:not([disabled])'),
  ];
  for (const loc of candidates) {
    const first = loc.first();
    if (await first.isVisible({ timeout: 2000 }).catch(() => false)) {
      return first;
    }
  }
  return null;
}

/** Fill LinkedIn contenteditable — plain fill() often leaves Send disabled. */
async function fillMessageEditor(
  page: Page,
  editor: Locator,
  text: string,
): Promise<void> {
  await editor.click({ timeout: 5000 });
  await page.waitForTimeout(400);

  const viaDom = await editor
    .evaluate((el, t) => {
      if (!(el instanceof HTMLElement)) return false;
      el.focus();
      const editable = el.getAttribute("contenteditable") === "true";
      if (editable) {
        el.innerHTML = "";
        el.innerText = t;
      } else if (el instanceof HTMLTextAreaElement) {
        el.value = t;
      } else {
        return false;
      }
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: t }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const got =
        (el.innerText || (el as HTMLTextAreaElement).value || "").trim().length > 5;
      return got;
    }, text)
    .catch(() => false);

  if (!viaDom) {
    await editor.click().catch(() => undefined);
    await page.keyboard.press("Meta+A").catch(() => page.keyboard.press("Control+A"));
    await page.keyboard.press("Backspace").catch(() => undefined);
    await page.keyboard.type(text, { delay: 12 });
  }

  await page.waitForTimeout(500);
}

/** True only for the Premium InMail modal — not ads, not the DM composer. */
async function dismissPremiumUpsell(page: Page): Promise<boolean> {
  if (await findMessageEditor(page, 400)) return false;

  const upsell = page
    .getByRole("dialog")
    .filter({ hasText: /Job Search Smarter|Reactivate Premium/i })
    .first();
  if (!(await upsell.isVisible().catch(() => false))) return false;

  const close = upsell
    .getByRole("button", { name: /^close$/i })
    .or(upsell.locator('button[aria-label="Dismiss"], button[aria-label="Close"]'))
    .first();
  if (await close.isVisible().catch(() => false)) {
    await close.click().catch(() => undefined);
  }
  await page.waitForTimeout(400);
  return true;
}

async function openMessageComposer(
  page: Page,
  profileUrl: string,
  quick: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await findMessageEditor(page)) {
    logStep(quick, "composer already open");
    return { ok: true };
  }

  logStep(quick, "clicking Message on profile…");
  if (!page.url().includes("/in/")) {
    await page.goto(profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: 40_000,
    });
    await page.waitForTimeout(800);
  }

  const topCard = profileIntro(page);
  const messageBtn = topCard
    .getByRole("button", { name: /^message$/i })
    .or(topCard.getByRole("link", { name: /^message$/i }))
    .first();

  if (await messageBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
    await messageBtn.click({ timeout: 12_000 });
  }

  const editor = await findMessageEditor(page);
  if (editor) return { ok: true };

  if (await dismissPremiumUpsell(page)) {
    return { ok: false, error: "inmail_premium_not_accepted" };
  }
  return { ok: false, error: "message_editor_not_found" };
}

async function detectStateWithRetry(
  page: Page,
  quick: boolean,
): Promise<Awaited<ReturnType<typeof detectConnectionState>>> {
  const attempts = quick ? 4 : 1;
  for (let i = 0; i < attempts; i++) {
    const state = await detectConnectionState(page);
    if (state !== "none" || i === attempts - 1) return state;
    logStep(quick, `state none — retry ${i + 2}/${attempts}`);
    await page.waitForTimeout(1500);
  }
  return "none";
}

async function clickSend(
  page: Page,
  editor: Locator,
  quick: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const send = await findMessageSend(page);
    if (send && (await send.isEnabled().catch(() => true))) {
      logStep(quick, "clicking Send…");
      await send.click({ timeout: 8000 });
      await page.waitForTimeout(1500);
      await closeMessageOverlays(page);
      return { ok: true };
    }
    logStep(quick, `Send not ready (attempt ${attempt + 1})…`);
    await editor.click().catch(() => undefined);
    await page.waitForTimeout(800);
  }

  logStep(quick, "trying Enter to send…");
  await editor.click().catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(1200);
  await closeMessageOverlays(page);
  return { ok: true };
}

/**
 * Visit profile; if Message is available (accepted), type a short DM.
 */
export async function messageAcceptedConnection(
  page: Page,
  opts: {
    profileUrl: string;
    message: string;
    dryRun: boolean;
    onlyAccepted?: boolean;
    quickCheck?: boolean;
  },
): Promise<MessageResult> {
  const quick = opts.quickCheck ?? false;
  const text = truncateFollowupMessage(opts.message);
  if (!text) {
    return { ok: false, error: "empty_message" };
  }

  logStep(quick, "closing leftover chat overlays…");
  await closeMessageOverlays(page);

  logStep(quick, "loading profile…");
  await page.goto(opts.profileUrl, {
    waitUntil: "domcontentloaded",
    timeout: quick ? 40_000 : 60_000,
  });

  if (quick) {
    await humanDelay("idle_micro", QUICK_DELAY);
  } else {
    await humanDelay("nav");
  }

  assertNotLogin(page, "linkedin followup message");
  await closeMessageOverlays(page);
  await page
    .locator("main, [data-view-name='profile-page']")
    .first()
    .waitFor({ timeout: quick ? 12_000 : 20_000 })
    .catch(() => undefined);

  if (quick) {
    await humanDelay("idle_micro", QUICK_DELAY);
  } else {
    await humanBrowseProfile(page);
  }
  recordAction("profile_view", 1);

  logStep(quick, "detecting connection state…");
  const signals = await readIntroSignals(page).catch(() => null);
  if (signals) {
    logStep(
      quick,
      `intro degree=${signals.degree} pending=${signals.pending} message=${signals.message} connect=${signals.connect} new=${signals.newConnection}`,
    );
  }
  const state = await detectStateWithRetry(page, quick);
  logStep(quick, `state=${state}`);

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

  if (await hasPendingInvite(page)) {
    logStep(quick, "Pending still visible — not accepted (InMail Message ignored)");
    return { ok: true, status: "skipped", detail: "not_accepted" };
  }

  assertWithinCap("message", 1);
  logStep(quick, "accepted (1st degree) — opening composer…");
  const opened = await openMessageComposer(page, opts.profileUrl, quick);
  if (!opened.ok) {
    return {
      ok: true,
      status: "skipped",
      detail: opened.error,
    };
  }

  logStep(quick, "typing message…");
  const editor = await findMessageEditor(page);
  if (!editor) {
    return { ok: false, error: "message_editor_not_found" };
  }

  await fillMessageEditor(page, editor, text);

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

  const sent = await clickSend(page, editor, quick);
  if (!sent.ok) {
    return sent;
  }

  recordAction("message", 1);
  return {
    ok: true,
    status: "messaged",
    detail: "sent",
    messagePreview: text.slice(0, 120),
  };
}
