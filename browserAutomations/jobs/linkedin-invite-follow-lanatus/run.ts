import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import {
  LINKEDIN_STORAGE_STATE,
  LINKEDIN_USER_DATA_DIR,
  looksLikeLoginOrChallenge,
  verifyFeedLoads,
} from "../../lib/auth.js";
import {
  assertJobRuntime,
  assertNoRestriction,
  assertWithinCap,
  beginJobRuntime,
  clampToRemainingCap,
  humanDelay,
  recordAction,
  remainingCap,
  safetyStatus,
  withLinkedInJobGuard,
} from "../../lib/linkedin-safety.js";
import { launchLinkedInContext } from "../../lib/leads/browser.js";
import {
  computeInviteBatchSize,
  parseInviteCredits,
  remainingDaysInMonth,
  type InviteMaxMode,
} from "../../lib/invite-pacing.js";
import {
  parsePriorityKeywords,
  rankCandidates,
  sanitizeInviteText,
  scoreCandidate,
  type InviteCandidate,
  type ScoredCandidate,
} from "../../lib/invite-ranking.js";
import type { JobRunResult } from "../../lib/job-types.js";
import {
  createJsonlLogger,
  jobLogPath,
  type LogEvent,
} from "../../lib/logging.js";

const DEFAULT_COMPANY_URL = "https://www.linkedin.com/company/lanatus/";

type InviteEvent = LogEvent;

function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return v === "true" || v === "1";
}

function envIntOptional(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

function getInviteMaxMode(): InviteMaxMode {
  const v = (process.env.INVITE_MAX_MODE ?? "cap").trim().toLowerCase();
  return v === "override" ? "override" : "cap";
}

function getCompanyUrl(): string {
  return (
    process.env.LANATUS_COMPANY_URL?.trim() ||
    process.env.LINKEDIN_COMPANY_URL?.trim() ||
    DEFAULT_COMPANY_URL
  );
}

function isHeadless(): boolean {
  return process.env.HEADLESS === "true" || process.env.HEADLESS === "1";
}

function createLogWriter(logPath: string) {
  return createJsonlLogger(logPath, (event) => {
    if (
      event.type === "candidate" ||
      event.type === "selected" ||
      event.type === "would_invite" ||
      event.type === "invited" ||
      event.type === "ranked" ||
      event.type === "skipped"
    ) {
      return `${event.name ?? ""}${
        event.score !== undefined ? ` score=${event.score}` : ""
      }${
        event.reasons
          ? ` [${Array.isArray(event.reasons) ? event.reasons.join(", ") : event.reasons}]`
          : ""
      }${event.headline ? ` — ${event.headline}` : ""}${
        event.skipReason ? ` (${event.skipReason})` : ""
      }${event.reason && !event.skipReason ? ` (${event.reason})` : ""}`;
    }
    if (event.type === "pacing") {
      return `credits=${event.remainingCredits}/${event.totalCredits} days=${event.remainingDays} batch=${event.batchSize}`;
    }
    if (event.type === "navigation") return String(event.url ?? "");
    if (event.message) return String(event.message);
    if (event.count !== undefined) return `count=${event.count}`;
    return "";
  });
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

/** Prefer human-like delay; floor with INVITE_DELAY_MS when provided. */
async function pacedDelay(
  kind:
    | "click"
    | "type_burst"
    | "read_card"
    | "nav"
    | "search"
    | "invite_think"
    | "idle_micro",
  floorMs: number,
): Promise<void> {
  await humanDelay(kind, { minMs: floorMs });
}

function assertNotLogin(page: Page, contextLabel: string): void {
  const url = page.url();
  assertNoRestriction(url, contextLabel);
  if (looksLikeLoginOrChallenge(url)) {
    throw new Error(
      `Redirected to login/checkpoint during ${contextLabel} (url=${url}). ` +
        "Run `npm run auth:linkedin` and try again.",
    );
  }
}

type ModalOpenResult = {
  dialog: Locator;
  creditsText: string;
  remainingCredits: number;
  totalCredits: number;
};

async function openInviteModal(
  page: Page,
  companyUrl: string,
  log: (e: InviteEvent) => void,
): Promise<ModalOpenResult> {
  log({ ts: new Date().toISOString(), type: "navigation", url: companyUrl });

  await page.goto(companyUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await pacedDelay("nav", 2000);
  assertNotLogin(page, "company page load");
  assertJobRuntime();
  recordAction("page_view");

  const inviteLink = page.getByRole("link", { name: /invite to follow/i });
  const onAdmin =
    /\/company\/\d+\/admin\//i.test(page.url()) ||
    (await inviteLink.first().isVisible().catch(() => false));

  if (!onAdmin) {
    throw new Error(
      "Could not reach Page admin view with Invite to follow.\n" +
        `Current URL: ${page.url()}\n` +
        "Confirm super/content admin access on the Lanatus Page.",
    );
  }

  if (await inviteLink.first().isVisible().catch(() => false)) {
    log({
      ts: new Date().toISOString(),
      type: "action",
      message: "Click Invite to follow",
    });
    await pacedDelay("click", 200);
    await inviteLink.first().click();
  } else {
    const u = new URL(page.url());
    if (!/\/admin\//i.test(u.pathname)) {
      throw new Error(
        `Invite to follow control not found on ${page.url()}. Confirm admin access.`,
      );
    }
    u.searchParams.set("invite", "true");
    log({
      ts: new Date().toISOString(),
      type: "navigation",
      url: u.toString(),
      message: "Fallback invite=true URL",
    });
    await page.goto(u.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }

  const dialog = page.getByRole("dialog").filter({
    hasText: /invite to follow|credits available|search by name/i,
  });
  await dialog.first().waitFor({ state: "visible", timeout: 20_000 });
  await pacedDelay("read_card", 2000);
  assertNotLogin(page, "invite modal open");
  recordAction("page_view");

  const creditsText = (await page.evaluate(`(() => {
    const root =
      document.querySelector('[role="dialog"]') ||
      document.querySelector(".artdeco-modal");
    const t = (root && root.textContent ? root.textContent : "").replace(/\\s+/g, " ");
    const m = t.match(/(\\d+\\s*\\/\\s*\\d+\\s*credits available[^·\\n]*)/i);
    if (m && m[1]) return m[1].trim();
    const m2 = t.match(/(\\d+\\s*\\/\\s*\\d+)/);
    return (m2 && m2[1] ? m2[1] : "").trim();
  })()`)) as string;

  const parsed = parseInviteCredits(creditsText || "");
  const remainingCredits = parsed?.remaining ?? -1;
  const totalCredits = parsed?.total ?? -1;

  log({
    ts: new Date().toISOString(),
    type: "modal_open",
    url: page.url(),
    credits: creditsText || undefined,
    remainingCredits: remainingCredits >= 0 ? remainingCredits : undefined,
    totalCredits: totalCredits >= 0 ? totalCredits : undefined,
  });

  if (!parsed) {
    throw new Error(
      `Could not parse invite credits from modal text: "${creditsText || "(empty)"}".`,
    );
  }

  return {
    dialog: dialog.first(),
    creditsText,
    remainingCredits: parsed.remaining,
    totalCredits: parsed.total,
  };
}

async function applySearchQuery(
  dialog: Locator,
  query: string,
  delayMs: number,
  log: (e: InviteEvent) => void,
): Promise<void> {
  const search = dialog
    .getByPlaceholder(/search by name/i)
    .or(dialog.getByRole("textbox", { name: /search by name/i }));

  await search.first().waitFor({ state: "visible", timeout: 10_000 });
  log({ ts: new Date().toISOString(), type: "search", query });
  assertWithinCap("search");
  await search.first().fill(query);
  await pacedDelay("type_burst", Math.min(delayMs, 400));
  await search.first().press("Enter").catch(() => undefined);
  await pacedDelay("search", delayMs);
  recordAction("search");
}

async function countCandidatesInPage(page: Page): Promise<number> {
  return page.evaluate(`(() => {
    const root =
      document.querySelector('[role="dialog"]') ||
      document.querySelector(".artdeco-modal");
    if (!root) return 0;
    const options = root.querySelectorAll('li[role="option"]').length;
    if (options > 0) return options;
    let n = 0;
    for (const l of root.querySelectorAll("label")) {
      const t = (l.textContent || "").replace(/\\s+/g, " ").trim();
      if (/^Select\\s+/i.test(t)) n++;
    }
    return n;
  })()`) as Promise<number>;
}

async function waitForCandidateList(
  page: Page,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await countCandidatesInPage(page);
    if (count > 0) return count;
    await delay(500);
  }
  return count;
}

async function listVisibleCandidates(page: Page): Promise<InviteCandidate[]> {
  const raw = (await page.evaluate(`(() => {
    const root =
      document.querySelector('[role="dialog"]') ||
      document.querySelector(".artdeco-modal");
    if (!root) return [];

    const out = [];
    const seen = new Set();

    const stripPremium = (s) =>
      (s || "")
        .replace(/Grow faster with[\\s\\S]*?(?:No hidden fees\\.?|Try Premium Page)/gi, " ")
        .replace(/Try Premium Page[\\s\\S]*?(?:No hidden fees\\.?)?/gi, " ")
        .replace(/\\s+/g, " ")
        .trim();

    for (const opt of Array.from(root.querySelectorAll('li[role="option"]'))) {
      const disabled =
        opt.getAttribute("aria-disabled") === "true" ||
        !!opt.querySelector('[disabled], [aria-disabled="true"]');

      let selectText = "";
      for (const l of opt.querySelectorAll("label")) {
        const t = (l.textContent || "").replace(/\\s+/g, " ").trim();
        if (/^Select\\s+/i.test(t)) {
          selectText = t;
          break;
        }
      }
      if (!selectText) continue;
      const nm = selectText.match(/^Select\\s+(.+)$/i);
      let name = stripPremium(((nm && nm[1]) || selectText).trim());
      name = stripPremium(name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      let headline = stripPremium(
        (opt.textContent || "")
          .replace(/\\s+/g, " ")
          .trim()
          .replace(selectText, "")
          .replace(name, ""),
      );
      if (headline.length > 120) headline = headline.slice(0, 117) + "…";
      out.push({
        name: name,
        headline: headline || undefined,
        disabled: disabled,
        rowText: stripPremium((opt.textContent || "").replace(/\\s+/g, " ")).slice(0, 200),
      });
    }

    if (out.length === 0) {
      for (const l of Array.from(root.querySelectorAll("label"))) {
        const selectText = (l.textContent || "").replace(/\\s+/g, " ").trim();
        if (!/^Select\\s+/i.test(selectText)) continue;
        const nm = selectText.match(/^Select\\s+(.+)$/i);
        const name = stripPremium(((nm && nm[1]) || selectText).trim());
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ name: name });
      }
    }

    return out;
  })()`)) as InviteCandidate[];

  return raw.map((c) => ({
    ...c,
    name: sanitizeInviteText(c.name),
    headline: c.headline ? sanitizeInviteText(c.headline) : undefined,
  }));
}

/** Normalize for fuzzy person-name matching inside the invite modal. */
function normalizePersonName(name: string): string {
  return sanitizeInviteText(name)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when a label/option accessible name refers to the candidate.
 * LinkedIn often appends Premium upsell copy after "Select {name}", so
 * exact equality fails even though listing already stripped that junk.
 */
function rowMatchesCandidate(
  rowAccessibleName: string,
  candidateName: string,
): boolean {
  const target = normalizePersonName(candidateName);
  if (!target) return false;
  let hay = normalizePersonName(rowAccessibleName);
  hay = hay.replace(/^select\s+/i, "").trim();
  if (!hay) return false;
  if (hay === target) return true;
  if (hay.startsWith(`${target} `)) return true;
  // Partial: candidate name appears as a contiguous token sequence
  const re = new RegExp(
    `(^|\\s)${escapeRegExp(target)}(?=\\s|$|grow faster|try premium)`,
    "i",
  );
  return re.test(hay);
}

type SelectAttemptResult =
  | { ok: true; method: string }
  | {
      ok: false;
      reason: "not_found" | "not_checkable" | "disabled";
      detail?: string;
    };

async function scrollInviteList(
  dialog: Locator,
  direction: "down" | "up" = "down",
): Promise<void> {
  await dialog.evaluate(
    `(root, dir) => {
      const candidates = [
        root.querySelector(".artdeco-modal__content"),
        root.querySelector('[class*="scaffold-finite-scroll"]'),
        root.querySelector('[class*="overflow"]'),
        ...Array.from(root.querySelectorAll("*")).filter((el) => {
          const s = window.getComputedStyle(el);
          return (
            (s.overflowY === "auto" || s.overflowY === "scroll") &&
            el.scrollHeight > el.clientHeight + 20
          );
        }),
      ];
      for (const el of candidates) {
        if (!el) continue;
        const delta = Math.max(180, Math.floor(el.clientHeight * 0.7));
        el.scrollTop += dir === "up" ? -delta : delta;
        return;
      }
    }`,
    direction,
  );
  await delay(350);
}

/**
 * Find and check a ranked connection in the invite modal.
 * Prefers role-based locators; falls back to label / option text match.
 * Native checkboxes are often visually hidden — do not require isVisible().
 */
async function tryCheckCandidateInModal(
  page: Page,
  dialog: Locator,
  candidate: ScoredCandidate,
  delayMs: number,
): Promise<SelectAttemptResult> {
  const name = candidate.name;
  const nameRe = new RegExp(escapeRegExp(name), "i");
  const selectRe = new RegExp(`Select\\s+${escapeRegExp(name)}`, "i");

  const tryClickCheckbox = async (
    box: Locator,
    method: string,
  ): Promise<SelectAttemptResult | null> => {
    const count = await box.count();
    if (count === 0) return null;
    const target = box.first();
    const disabled =
      (await target.isDisabled().catch(() => false)) ||
      (await target.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (disabled) {
      return { ok: false, reason: "disabled", detail: method };
    }
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    const checked =
      (await target.isChecked().catch(() => false)) ||
      (await target.getAttribute("aria-checked").catch(() => null)) === "true";
    if (!checked) {
      // LinkedIn often hides the native input; force click still toggles it.
      await target.click({ timeout: 5_000, force: true });
      await delay(200);
    }
    return { ok: true, method };
  };

  /** DOM fallback: partial "Select {name}" match (premium suffix OK). */
  const tryDomLabelClick = async (): Promise<SelectAttemptResult | null> => {
    const result = (await page.evaluate(
      `(targetName) => {
        const root =
          document.querySelector('[role="dialog"]') ||
          document.querySelector(".artdeco-modal");
        if (!root) return { ok: false, reason: "no_dialog" };
        const norm = (s) =>
          (s || "")
            .replace(/Grow faster with[\\s\\S]*?(?:No hidden fees\\.?|Try Premium Page)/gi, " ")
            .replace(/Try Premium Page[\\s\\S]*?(?:No hidden fees\\.?)?/gi, " ")
            .replace(/\\s+/g, " ")
            .trim()
            .toLowerCase();
        const target = norm(targetName);
        if (!target) return { ok: false, reason: "empty" };

        const matches = (raw) => {
          let hay = norm(raw).replace(/^select\\s+/i, "").trim();
          if (!hay) return false;
          if (hay === target || hay.startsWith(target + " ")) return true;
          return hay.includes(target);
        };

        for (const opt of Array.from(root.querySelectorAll('li[role="option"]'))) {
          const text = (opt.textContent || "").replace(/\\s+/g, " ");
          if (!matches(text) && !matches(text.replace(/^select\\s+/i, ""))) continue;
          if (opt.getAttribute("aria-disabled") === "true") {
            return { ok: false, reason: "disabled" };
          }
          const input = opt.querySelector('input[type="checkbox"]');
          if (input) {
            if (input.disabled || input.getAttribute("aria-disabled") === "true") {
              return { ok: false, reason: "disabled" };
            }
            if (!input.checked) {
              input.click();
              if (!input.checked) {
                const lab = opt.querySelector("label");
                if (lab) lab.click();
              }
            }
            return { ok: true, method: "dom:option-checkbox" };
          }
          const lab = opt.querySelector("label");
          if (lab && matches(lab.textContent || "")) {
            lab.click();
            return { ok: true, method: "dom:option-label" };
          }
          opt.click();
          return { ok: true, method: "dom:option-row" };
        }

        let saw = false;
        for (const l of Array.from(root.querySelectorAll("label"))) {
          const t = (l.textContent || "").replace(/\\s+/g, " ").trim();
          if (!/^Select\\s+/i.test(t)) continue;
          if (!matches(t)) continue;
          saw = true;
          const forId = l.getAttribute("for");
          const input = forId
            ? document.getElementById(forId)
            : l.querySelector('input[type="checkbox"]');
          if (input && (input.disabled || input.getAttribute("aria-disabled") === "true")) {
            return { ok: false, reason: "disabled" };
          }
          l.click();
          if (input && !input.checked) {
            input.click();
          }
          return { ok: true, method: "dom:label" };
        }
        return saw
          ? { ok: false, reason: "not_checkable" }
          : { ok: false, reason: "not_found" };
      }`,
      name,
    )) as {
      ok: boolean;
      reason?: string;
      method?: string;
    };

    if (result.ok) {
      return { ok: true, method: result.method || "dom" };
    }
    if (result.reason === "disabled") {
      return { ok: false, reason: "disabled", detail: "dom" };
    }
    if (result.reason === "not_checkable") {
      return {
        ok: false,
        reason: "not_checkable",
        detail: "dom_label_matched_uncheckable",
      };
    }
    return null;
  };

  let lastNotCheckable: SelectAttemptResult | null = null;

  // Scan currently loaded rows with scroll retries (virtualized lists).
  for (let attempt = 0; attempt < 10; attempt++) {
    // 1) Checkbox whose accessible name matches Select {name}…
    {
      const bySelect = dialog.getByRole("checkbox", { name: selectRe });
      const r = await tryClickCheckbox(bySelect, "checkbox:select-name");
      if (r?.ok) return r;
      if (r && r.reason === "disabled") return r;
    }

    // 2) Checkbox whose accessible name contains the person name
    {
      const byName = dialog.getByRole("checkbox", { name: nameRe });
      const n = await byName.count();
      for (let i = 0; i < n; i++) {
        const box = byName.nth(i);
        const accName =
          (await box.getAttribute("aria-label").catch(() => null)) ||
          (await box.evaluate(`(el) => {
            const id = el.getAttribute("id");
            if (id) {
              const lab = document.querySelector(
                'label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]',
              );
              if (lab) return (lab.textContent || "").replace(/\\s+/g, " ").trim();
            }
            const wrap = el.closest("label");
            if (wrap) return (wrap.textContent || "").replace(/\\s+/g, " ").trim();
            return (el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
          }`).catch(() => "")) ||
          "";
        if (accName && !rowMatchesCandidate(String(accName), name)) continue;
        const r = await tryClickCheckbox(box, "checkbox:partial-name");
        if (r?.ok) return r;
        if (r && r.reason === "disabled") return r;
      }
    }

    // 3) option row → inner checkbox / label / row click
    {
      const options = dialog.getByRole("option");
      const optCount = await options.count();
      for (let i = 0; i < optCount; i++) {
        const opt = options.nth(i);
        const optText = (
          (await opt.innerText().catch(() => "")) ||
          (await opt.textContent().catch(() => "")) ||
          ""
        ).replace(/\s+/g, " ");
        if (!rowMatchesCandidate(optText, name) && !nameRe.test(optText)) {
          continue;
        }
        const disabled =
          (await opt.getAttribute("aria-disabled").catch(() => null)) ===
            "true" ||
          (await opt.locator('[disabled], [aria-disabled="true"]').count()) > 0;
        if (disabled) {
          return { ok: false, reason: "disabled", detail: "option" };
        }
        await opt.scrollIntoViewIfNeeded().catch(() => undefined);
        const box = opt.getByRole("checkbox");
        if ((await box.count()) > 0) {
          const r = await tryClickCheckbox(box, "option:checkbox");
          if (r?.ok) return r;
          if (r && r.reason === "disabled") return r;
        }
        const lab = opt.locator("label").filter({ hasText: selectRe });
        if ((await lab.count()) > 0) {
          await lab.first().click({ timeout: 5_000, force: true });
          await delay(200);
          return { ok: true, method: "option:label" };
        }
        await opt.click({ timeout: 5_000 });
        await delay(200);
        return { ok: true, method: "option:row-click" };
      }
    }

    // 4) Labels with Select {name}… (premium suffix OK)
    {
      const labels = dialog.locator("label");
      const labelCount = await labels.count();
      for (let i = 0; i < labelCount; i++) {
        const lab = labels.nth(i);
        const t = (
          (await lab.textContent().catch(() => "")) || ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (!/^select\s+/i.test(t)) continue;
        if (!rowMatchesCandidate(t, name)) continue;
        await lab.scrollIntoViewIfNeeded().catch(() => undefined);
        const forId = await lab.getAttribute("for").catch(() => null);
        if (forId) {
          const byId = page.locator(`[id=${JSON.stringify(forId)}]`);
          const r = await tryClickCheckbox(byId, "label:for-checkbox");
          if (r?.ok) return r;
          if (r && r.reason === "disabled") return r;
        }
        try {
          await lab.click({ timeout: 5_000, force: true });
          await delay(200);
          return { ok: true, method: "label:text" };
        } catch {
          lastNotCheckable = {
            ok: false,
            reason: "not_checkable",
            detail: "label_click_failed",
          };
        }
      }
    }

    // 5) Direct DOM partial-match click (mirrors listing extraction)
    {
      const dom = await tryDomLabelClick();
      if (dom?.ok) return dom;
      if (dom && dom.reason === "disabled") return dom;
      if (dom && dom.reason === "not_checkable") lastNotCheckable = dom;
    }

    // Bring more rows into view
    if (attempt < 5) {
      await scrollInviteList(dialog, "down");
    } else if (attempt === 5) {
      await dialog.evaluate(`(root) => {
        const scroller =
          root.querySelector(".artdeco-modal__content") ||
          Array.from(root.querySelectorAll("*")).find((el) => {
            const s = window.getComputedStyle(el);
            return (
              (s.overflowY === "auto" || s.overflowY === "scroll") &&
              el.scrollHeight > el.clientHeight + 20
            );
          });
        if (scroller) scroller.scrollTop = 0;
      }`);
      await delay(400);
    } else {
      await scrollInviteList(dialog, "down");
      if (await clickShowMoreIfNeeded(page, delayMs)) {
        await delay(400);
      }
    }
  }

  return lastNotCheckable ?? { ok: false, reason: "not_found" };
}

async function selectCandidate(
  page: Page,
  dialog: Locator,
  candidate: ScoredCandidate,
  dryRun: boolean,
  delayMs: number,
  log: (e: InviteEvent) => void,
): Promise<"selected" | "would_invite" | "skipped"> {
  if (dryRun) {
    log({
      ts: new Date().toISOString(),
      type: "would_invite",
      name: candidate.name,
      headline: candidate.headline,
      score: candidate.score,
      reasons: candidate.reasons,
    });
    return "would_invite";
  }

  const result = await tryCheckCandidateInModal(
    page,
    dialog,
    candidate,
    delayMs,
  );

  if (!result.ok) {
    const reason =
      result.reason === "disabled"
        ? "row_disabled"
        : result.reason === "not_checkable"
          ? "row_visible_not_checkable"
          : "label_not_found";
    log({
      ts: new Date().toISOString(),
      type: "skipped",
      name: candidate.name,
      reason,
      detail: result.detail,
      score: candidate.score,
      reasons: candidate.reasons,
    });
    return "skipped";
  }

  log({
    ts: new Date().toISOString(),
    type: "selected",
    name: candidate.name,
    headline: candidate.headline,
    score: candidate.score,
    reasons: candidate.reasons,
    method: result.method,
  });
  await pacedDelay("click", Math.min(delayMs, 400));
  return "selected";
}

async function clickShowMoreIfNeeded(
  page: Page,
  delayMs: number,
): Promise<boolean> {
  const clicked = (await page.evaluate(`(() => {
    const root =
      document.querySelector('[role="dialog"]') ||
      document.querySelector(".artdeco-modal");
    if (!root) return false;
    for (const b of root.querySelectorAll("button")) {
      if (/show more results/i.test((b.textContent || "").trim())) {
        if (b.disabled) return false;
        b.click();
        return true;
      }
    }
    return false;
  })()`)) as boolean;
  if (clicked) await delay(delayMs + 500);
  return clicked;
}

/**
 * Collect a pool of candidates (larger than batch) via Show more, then rank.
 */
async function collectAndRankCandidates(
  page: Page,
  batchSize: number,
  delayMs: number,
  keywords: string[],
  log: (e: InviteEvent) => void,
): Promise<{ pool: ScoredCandidate[]; selected: ScoredCandidate[] }> {
  const poolTarget = Math.max(batchSize * 3, batchSize + 10, 20);
  const seen = new Map<string, InviteCandidate>();
  let attempts = 0;

  while (seen.size < poolTarget && attempts < 10) {
    attempts++;
    const candidates = await listVisibleCandidates(page);
    for (const c of candidates) {
      const key = c.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, c);
    }
    if (seen.size >= poolTarget) break;
    if (!(await clickShowMoreIfNeeded(page, delayMs))) break;
  }

  const allScored: ScoredCandidate[] = [];
  for (const c of seen.values()) {
    const scored = scoreCandidate(c, keywords);
    allScored.push(scored);
    log({
      ts: new Date().toISOString(),
      type: scored.skip ? "skipped" : "candidate",
      name: scored.name,
      headline: scored.headline,
      score: scored.score,
      reasons: scored.reasons,
      skipReason: scored.skipReason,
    });
  }

  const selected = rankCandidates(
    [...seen.values()],
    keywords,
    batchSize,
  );

  for (const s of selected) {
    log({
      ts: new Date().toISOString(),
      type: "ranked",
      name: s.name,
      headline: s.headline,
      score: s.score,
      reasons: s.reasons,
    });
  }

  // Log non-selected (not skipped junk) that were deprioritized
  const selectedKeys = new Set(selected.map((s) => s.name.toLowerCase()));
  for (const s of allScored) {
    if (s.skip) continue;
    if (selectedKeys.has(s.name.toLowerCase())) continue;
    log({
      ts: new Date().toISOString(),
      type: "skipped",
      name: s.name,
      headline: s.headline,
      score: s.score,
      reasons: s.reasons,
      skipReason: "below_batch_cutoff",
    });
  }

  return { pool: allScored, selected };
}

async function sendInvites(
  dialog: Locator,
  dryRun: boolean,
  selectedCount: number,
  log: (e: InviteEvent) => void,
): Promise<void> {
  if (dryRun) {
    log({
      ts: new Date().toISOString(),
      type: "dry_run_skip_send",
      message: "Skipping Invite click (INVITE_DRY_RUN)",
    });
    return;
  }

  // Primary CTA variants: Invite, Invite (2), Invite 2, Send, Send invitations
  const inviteBtn = dialog
    .getByRole("button", {
      name: /invite(\s*\(?\d+\)?)?|send(\s+invitations?)?/i,
    })
    .or(
      dialog.locator("button").filter({
        hasText: /invite|send invitations?/i,
      }),
    );

  let clicked = false;
  const count = await inviteBtn.count();
  for (let i = 0; i < count; i++) {
    const btn = inviteBtn.nth(i);
    const label = (
      (await btn.innerText().catch(() => "")) ||
      (await btn.textContent().catch(() => "")) ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    // Skip secondary actions (Cancel, close, Show more, Premium upsell)
    if (
      !/invite|send/i.test(label) ||
      /cancel|close|show more|premium|dismiss|back/i.test(label)
    ) {
      continue;
    }
    const disabled =
      (await btn.isDisabled().catch(() => false)) ||
      (await btn.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (disabled) {
      throw new Error(
        `Invite button is disabled after selecting ${selectedCount} connection(s) — ` +
          "selection may not have registered, or credits are exhausted.",
      );
    }
    await btn.click({ timeout: 10_000 });
    clicked = true;
    log({
      ts: new Date().toISOString(),
      type: "invite_clicked",
      selectedCount,
      buttonLabel: label || undefined,
    });
    break;
  }

  if (!clicked) {
    // DOM fallback — LinkedIn sometimes nests the CTA outside role=button text
    const dom = (await dialog.evaluate(`(root) => {
      const buttons = Array.from(root.querySelectorAll("button"));
      const labels = buttons.map((b) =>
        (b.textContent || "").replace(/\\s+/g, " ").trim(),
      );
      for (const b of buttons) {
        const t = (b.textContent || "").replace(/\\s+/g, " ").trim();
        if (!/invite|send invitations?/i.test(t)) continue;
        if (/cancel|close|show more|premium|dismiss|back/i.test(t)) continue;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") {
          return { ok: false, reason: "disabled", labels };
        }
        b.click();
        return { ok: true, label: t, labels };
      }
      // Footer primary often uses artdeco-button--primary
      const primary = root.querySelector(
        "button.artdeco-button--primary, .artdeco-modal__actionbar button.artdeco-button--primary",
      );
      if (primary) {
        const t = (primary.textContent || "").replace(/\\s+/g, " ").trim();
        if (primary.disabled || primary.getAttribute("aria-disabled") === "true") {
          return { ok: false, reason: "disabled", label: t, labels };
        }
        primary.click();
        return { ok: true, label: t || "(primary)", labels };
      }
      return { ok: false, reason: "no_button", labels };
    })`)) as {
      ok: boolean;
      reason?: string;
      label?: string;
      labels?: string[];
    };

    if (dom.ok) {
      log({
        ts: new Date().toISOString(),
        type: "invite_clicked",
        selectedCount,
        buttonLabel: dom.label,
        method: "dom",
      });
    } else if (dom.reason === "disabled") {
      throw new Error(
        `Invite button is disabled after selecting ${selectedCount} connection(s) — ` +
          "selection may not have registered, or credits are exhausted.",
      );
    } else {
      const sample = (dom.labels || [])
        .filter(Boolean)
        .slice(0, 12)
        .join(" | ");
      throw new Error(
        "Invite/Send button not found in modal." +
          (sample ? ` Visible buttons: ${sample}` : ""),
      );
    }
  }

  await delay(2_000);
}

export async function run(): Promise<JobRunResult> {
  if (
    !fs.existsSync(LINKEDIN_STORAGE_STATE) &&
    !fs.existsSync(LINKEDIN_USER_DATA_DIR)
  ) {
    return {
      exitCode: 1,
      message:
        "Missing LinkedIn session. Run `npm run auth:linkedin` first.",
    };
  }

  const companyUrl = getCompanyUrl();
  const inviteMax = envIntOptional("INVITE_MAX");
  const inviteMaxMode = getInviteMaxMode();
  const delayMs = envInt("INVITE_DELAY_MS", 2000);
  const dryRun = envBool("INVITE_DRY_RUN", true);
  const query = process.env.INVITE_QUERY?.trim() || "";
  const keywords = parsePriorityKeywords(
    process.env.INVITE_PRIORITY_KEYWORDS,
  );
  const headless = isHeadless();
  const now = new Date();
  const status = safetyStatus();

  const logPath = jobLogPath("linkedin-invite");
  const writer = createLogWriter(logPath);
  const relativeLog = path.relative(process.cwd(), logPath);

  writer.log({
    ts: new Date().toISOString(),
    type: "run_start",
    companyUrl,
    inviteMax: inviteMax ?? null,
    inviteMaxMode,
    delayMs,
    dryRun,
    query: query || undefined,
    headless,
    logFile: relativeLog,
    remainingDaysHint: remainingDaysInMonth(now),
    keywordCount: keywords.length,
    safety: status,
  });

  console.log("\n════════════════════════════════════════");
  console.log(" LinkedIn Invite to follow — Lanatus");
  console.log(` Company:  ${companyUrl}`);
  console.log(
    ` Cap:      ${
      inviteMax !== undefined
        ? `${inviteMax} (${inviteMaxMode})`
        : "none (pace-only)"
    }`,
  );
  console.log(
    ` Safe/day: invites ${status.remaining.invite}/${status.caps.invite} left`,
  );
  console.log(` Delay:    ${delayMs}ms (×${status.delayMult} human)`);
  console.log(` Dry-run:  ${dryRun}`);
  if (query) console.log(` Query:    ${query}`);
  console.log(` Log:      ${relativeLog}`);
  console.log("════════════════════════════════════════\n");

  if (!dryRun) {
    console.warn(
      "INVITE_DRY_RUN=false — will select connections and click Invite.\n",
    );
  }

  try {
    return await withLinkedInJobGuard(
      "linkedin-invite-follow-lanatus",
      async () => {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let result: JobRunResult = { exitCode: 0 };

    try {
      const launched = await launchLinkedInContext(headless);
      browser = launched.browser;
      context = launched.context;
      writer.log({
        ts: new Date().toISOString(),
        type: "browser_launch",
        mode: launched.mode,
      });

      const page = context.pages()[0] ?? (await context.newPage());
      const auth = await verifyFeedLoads(page, context);
      assertNoRestriction(auth.url, "feed verify");
      if (!auth.ok || looksLikeLoginOrChallenge(auth.url)) {
        throw new Error(
          `Not authenticated (url=${auth.url}). Run \`npm run auth:linkedin\`.`,
        );
      }
      writer.log({
        ts: new Date().toISOString(),
        type: "auth_ok",
        url: auth.url,
      });
      // Start runtime clock only after browser + auth are ready
      beginJobRuntime("linkedin-invite-follow-lanatus");
      assertJobRuntime();
      recordAction("page_view");
      await pacedDelay("nav", delayMs);

      const modal = await openInviteModal(page, companyUrl, writer.log);
      const daysLeft = remainingDaysInMonth(now);
      const pacing = computeInviteBatchSize({
        remainingCredits: modal.remainingCredits,
        remainingDays: daysLeft,
        inviteMax,
        inviteMaxMode,
      });

      const dailyLeft = remainingCap("invite");
      const batchSize = clampToRemainingCap("invite", pacing.batchSize);

      writer.log({
        ts: new Date().toISOString(),
        type: "pacing",
        remainingCredits: pacing.remainingCredits,
        totalCredits: modal.totalCredits,
        remainingDays: pacing.remainingDays,
        remainingDaysIncludesToday: true,
        computed: pacing.computed,
        batchSize,
        pacedBatch: pacing.batchSize,
        dailyInviteRemaining: dailyLeft,
        inviteMax: pacing.inviteMax ?? null,
        inviteMaxMode: pacing.inviteMaxMode,
        creditsRaw: modal.creditsText,
      });

      console.log(
        `Pacing: ${pacing.remainingCredits}/${modal.totalCredits} credits, ` +
          `${pacing.remainingDays} day(s) left (incl. today) → ` +
          `batch ${batchSize}` +
          (pacing.batchSize !== batchSize
            ? ` (paced ${pacing.batchSize}, daily-cap ${dailyLeft})`
            : pacing.computed !== pacing.batchSize
              ? ` (computed ${pacing.computed})`
              : "") +
          "\n",
      );

      if (
        pacing.remainingCredits === 0 ||
        pacing.batchSize === 0 ||
        batchSize === 0
      ) {
        const msg =
          pacing.remainingCredits === 0
            ? `No invitation credits left this month (${modal.creditsText}). Nothing to send today.`
            : batchSize === 0 && pacing.batchSize > 0
              ? `Daily invite safety cap reached (0/${status.caps.invite} left). Nothing to send today.`
              : `Computed batch is 0 (credits=${pacing.remainingCredits}, daysLeft=${pacing.remainingDays}). Nothing to send today.`;
        writer.log({
          ts: new Date().toISOString(),
          type: "nothing_to_send",
          message: msg,
          remainingCredits: pacing.remainingCredits,
          remainingDays: pacing.remainingDays,
          batchSize,
        });
        console.log(msg + "\n");
        writer.log({
          ts: new Date().toISOString(),
          type: "run_end",
          dryRun,
          selectedCount: 0,
          wouldInviteCount: 0,
          selected: [],
          wouldInvite: [],
          batchSize: 0,
        });
        console.log(`Log → ${relativeLog}\n`);
        result = { exitCode: 0, softSuccess: true, message: msg };
        return result;
      }

      const foundCount = await waitForCandidateList(page);
      writer.log({
        ts: new Date().toISOString(),
        type: "candidates_ready",
        count: foundCount,
      });

      if (query) {
        await applySearchQuery(modal.dialog, query, delayMs, writer.log);
        const afterSearch = await waitForCandidateList(page, 15_000);
        writer.log({
          ts: new Date().toISOString(),
          type: "candidates_ready",
          count: afterSearch,
          afterSearch: true,
        });
      }

      const { selected: ranked } = await collectAndRankCandidates(
        page,
        batchSize,
        delayMs,
        keywords,
        writer.log,
      );

      const selectedNames: string[] = [];
      const wouldInvite: string[] = [];
      const skipReasons: string[] = [];

      for (const c of ranked) {
        assertJobRuntime();
        if (!dryRun) {
          assertWithinCap("invite", selectedNames.length + 1);
        }
        await pacedDelay("invite_think", Math.min(delayMs, 800));
        const selectResult = await selectCandidate(
          page,
          modal.dialog,
          c,
          dryRun,
          delayMs,
          writer.log,
        );
        if (selectResult === "selected") selectedNames.push(c.name);
        if (selectResult === "would_invite") wouldInvite.push(c.name);
        if (selectResult === "skipped") skipReasons.push(c.name);
        await pacedDelay("idle_micro", Math.min(delayMs, 500));
      }

      if (selectedNames.length + wouldInvite.length === 0) {
        const rankedNames = ranked.map((c) => c.name).join(", ");
        const msg =
          `No invitable connections could be checked after ranking` +
          (query ? ` for query "${query}"` : "") +
          (rankedNames ? ` (ranked: ${rankedNames})` : "") +
          ". Rows may be visible but not checkable, already invited, or the Select/checkbox label did not match.";
        if (dryRun) {
          writer.log({
            ts: new Date().toISOString(),
            type: "warn",
            message: msg,
            skipReasons,
          });
          console.warn("\n" + msg + "\n");
        } else {
          throw new Error(msg);
        }
      }

      if (!dryRun && selectedNames.length > 0) {
        assertWithinCap("invite", selectedNames.length);
        await sendInvites(
          modal.dialog,
          false,
          selectedNames.length,
          writer.log,
        );
        recordAction("invite", selectedNames.length);
        for (const name of selectedNames) {
          writer.log({ ts: new Date().toISOString(), type: "invited", name });
        }
      } else {
        await sendInvites(modal.dialog, true, 0, writer.log);
      }

      writer.log({
        ts: new Date().toISOString(),
        type: "run_end",
        dryRun,
        selectedCount: selectedNames.length,
        wouldInviteCount: wouldInvite.length,
        selected: selectedNames,
        wouldInvite,
        batchSize,
        remainingCredits: pacing.remainingCredits,
        remainingDays: pacing.remainingDays,
      });

      console.log("\n── Summary ──");
      if (dryRun) {
        console.log(
          `Dry-run OK: credits ${pacing.remainingCredits}/${modal.totalCredits}, ` +
            `${pacing.remainingDays} days left → batch ${batchSize}; ` +
            `would invite ${wouldInvite.length} (Invite not clicked).`,
        );
        for (const c of ranked.slice(0, 30)) {
          console.log(
            `  • ${c.name} (score=${c.score}${
              c.reasons.length ? `; ${c.reasons.slice(0, 3).join(", ")}` : ""
            })`,
          );
        }
        if (wouldInvite.length > 30) {
          console.log(`  … and ${wouldInvite.length - 30} more`);
        }
        console.log(
          "\nTo send for real:\n  npm run jobs:run -- linkedin-invite-follow-lanatus --no-dry-run",
        );
      } else {
        console.log(`Sent invites for ${selectedNames.length} connection(s).`);
      }
      console.log(`Log → ${relativeLog}\n`);
      result = { exitCode: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writer.log({ ts: new Date().toISOString(), type: "error", message });
      console.error("\n" + message + "\n");
      throw err;
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }

    return result;
  },
    );
  } finally {
    await writer.close().catch(() => undefined);
  }
}

/** Direct CLI entry (also used by automations/ shim). */
async function main(): Promise<void> {
  try {
    const result = await run();
    if (result.message && result.exitCode !== 0) {
      console.error(result.message);
    }
    process.exit(result.exitCode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]).includes(
    path.join("linkedin-invite-follow-lanatus", "run"),
  );

if (isDirect) {
  main();
}
