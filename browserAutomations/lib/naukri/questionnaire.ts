/**
 * Fill Naukri apply screening questions (chatbot drawer / modal / form).
 * Answers come from NAUKRI_PROFILE_* env vars (+ optional resume upload).
 */

import type { Locator, Page } from "playwright";
import { envBool, envList, naukriResumePath } from "./env.js";
import { naukriDelay } from "./safety.js";

export type ProfileAnswers = {
  noticePeriodDays: number;
  currentCtcLpa: number;
  expectedCtcLpa: number;
  experienceYears: number;
  relocate: boolean;
  city: string;
  servingNotice: boolean;
  /** Free-text fallback for unmatched questions */
  defaultText: string;
  /** Prefer Yes on unmatched yes/no questions */
  defaultYes: boolean;
};

export function loadProfileAnswers(): ProfileAnswers {
  const num = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    noticePeriodDays: Math.floor(num("NAUKRI_PROFILE_NOTICE_PERIOD_DAYS", 30)),
    currentCtcLpa: num("NAUKRI_PROFILE_CURRENT_CTC_LPA", 8),
    expectedCtcLpa: num("NAUKRI_PROFILE_EXPECTED_CTC_LPA", 12),
    experienceYears: Math.floor(num("NAUKRI_PROFILE_EXPERIENCE_YEARS", 3)),
    relocate: envBool("NAUKRI_PROFILE_RELOCATE", true),
    city:
      process.env.NAUKRI_PROFILE_CITY?.trim() ||
      envList("NAUKRI_GEOS", ["Ahmedabad"])[0] ||
      "Ahmedabad",
    servingNotice: envBool("NAUKRI_PROFILE_SERVING_NOTICE", false),
    defaultText:
      process.env.NAUKRI_PROFILE_DEFAULT_TEXT?.trim() ||
      "Yes, I am interested and available as per the role requirements.",
    defaultYes: envBool("NAUKRI_PROFILE_DEFAULT_YES", true),
  };
}

type AnswerKind =
  | { type: "text"; value: string }
  | { type: "number"; value: string }
  | { type: "yesNo"; yes: boolean }
  | { type: "skip" };

function normalizeLabel(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Map a question label → answer strategy. */
export function answerForQuestion(
  labelRaw: string,
  profile: ProfileAnswers,
): AnswerKind {
  const q = normalizeLabel(labelRaw);

  if (!q || q.length < 2) return { type: "skip" };

  // Greeting / instructional bot lines — not questions
  if (
    /thank you for showing interest|kindly answer|recruiter'?s questions|successfully apply/.test(
      q,
    ) &&
    !/\?/.test(q)
  ) {
    return { type: "skip" };
  }

  // Notice period
  if (
    /notice\s*period|how soon can you join|joining|availability|when can you join/.test(
      q,
    )
  ) {
    if (/month/.test(q)) {
      return {
        type: "number",
        value: String(Math.max(1, Math.round(profile.noticePeriodDays / 30))),
      };
    }
    return { type: "number", value: String(profile.noticePeriodDays) };
  }

  if (/serving\s*notice|currently serving/.test(q)) {
    return { type: "yesNo", yes: profile.servingNotice };
  }

  // CTC / salary
  if (/current\s*(ctc|salary|pay)|present\s*(ctc|salary)/.test(q)) {
    return { type: "number", value: String(profile.currentCtcLpa) };
  }
  if (/expected\s*(ctc|salary|pay)|desired\s*(ctc|salary)/.test(q)) {
    return { type: "number", value: String(profile.expectedCtcLpa) };
  }
  if (/\bctc\b|\bsalary\b/.test(q) && /expect|desir|looking/.test(q)) {
    return { type: "number", value: String(profile.expectedCtcLpa) };
  }
  if (/\bctc\b|\bsalary\b/.test(q)) {
    return { type: "number", value: String(profile.currentCtcLpa) };
  }

  // Experience
  if (
    /total\s*experience|years?\s*of\s*experience|experience\s*\(years|how many years/.test(
      q,
    )
  ) {
    return { type: "number", value: String(profile.experienceYears) };
  }
  if (/relevant\s*experience/.test(q)) {
    return {
      type: "number",
      value: String(Math.max(1, profile.experienceYears - 1)),
    };
  }

  // Location / relocate (incl. "living in or ready to relocate to X")
  if (
    /relocat|willing to move|open to relocate|living in or ready|ready to (move|relocate)|based in/.test(
      q,
    )
  ) {
    return { type: "yesNo", yes: profile.relocate };
  }
  if (
    /current\s*(location|city)|preferred\s*(location|city)|where are you (based|located)/.test(
      q,
    )
  ) {
    return { type: "text", value: profile.city };
  }

  // Resume / CV upload prompts
  if (/upload.*(resume|cv)|attach.*(resume|cv)|resume|curriculum/.test(q)) {
    return { type: "text", value: "__RESUME__" };
  }

  // Yes/No interest / skills confirmation
  if (
    /are you (interested|comfortable|willing|available|okay|ok)|do you (have|know|agree|accept)|can you|have you/.test(
      q,
    ) ||
    /\?$/.test(q.trim())
  ) {
    if (
      /yes\s*\/\s*no|y\/n|true\s*\/\s*false/.test(q) ||
      /^(are|do|can|have|will|is|would)\b/.test(q)
    ) {
      return { type: "yesNo", yes: profile.defaultYes };
    }
  }

  // Skills / tech — affirm
  if (/react|node|mern|javascript|typescript|mongo|express|full\s*stack|powerapps/.test(q)) {
    if (/year|exp/.test(q)) {
      return {
        type: "number",
        value: String(Math.max(1, profile.experienceYears - 1)),
      };
    }
    return { type: "yesNo", yes: true };
  }

  // Generic short text
  if (/comment|reason|describe|tell us|cover|message|note/.test(q)) {
    return { type: "text", value: profile.defaultText };
  }

  if (/\?$/.test(q) || /^(are|do|can|have|will|is|would)\b/.test(q)) {
    return { type: "yesNo", yes: profile.defaultYes };
  }

  return { type: "text", value: profile.defaultText };
}

function chatbotDrawer(page: Page): Locator {
  return page.locator(".chatbot_Drawer").first();
}

async function clickYesNoIn(
  scope: Locator,
  yes: boolean,
): Promise<boolean> {
  const label = yes ? "Yes" : "No";
  const candidates = [
    scope.locator(`label.ssrc__label[for="${label}"]`),
    scope.locator(`label.ssrc__label:text-is("${label}")`),
    scope.locator(`.ssrc__radio-btn-container:has-text("${label}") label`),
    scope.locator(`input.ssrc__radio#${label}`),
    scope.locator(`input.ssrc__radio[value="${label}"]`),
    scope.getByRole("radio", { name: new RegExp(`^${label}$`, "i") }),
    scope.locator(`label:has-text("${label}")`),
  ];
  for (const c of candidates) {
    const el = c.first();
    if (await el.isVisible({ timeout: 700 }).catch(() => false)) {
      // Avoid force:true — Naukri chatbot listeners need a real click
      await el.click({ timeout: 3000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function fillNativeInput(loc: Locator, value: string): Promise<boolean> {
  if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) return false;
  const tag = await loc
    .evaluate((el) => el.tagName.toLowerCase())
    .catch(() => "");
  if (tag === "select") {
    try {
      await loc.selectOption({ label: value }).catch(async () => {
        await loc.selectOption({ value }).catch(async () => {
          const opts = loc.locator("option");
          const n = await opts.count();
          for (let i = 0; i < n; i++) {
            const t = ((await opts.nth(i).textContent()) || "").trim();
            if (t.toLowerCase().includes(value.toLowerCase())) {
              await loc.selectOption({ index: i });
              return;
            }
          }
        });
      });
      return true;
    } catch {
      return false;
    }
  }
  await loc.click({ force: true }).catch(() => undefined);
  await loc.fill("").catch(() => undefined);
  await loc.fill(value).catch(async () => {
    await loc.evaluate((el, v) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      input.focus();
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  });
  return true;
}

async function fillContentEditable(
  loc: Locator,
  value: string,
): Promise<boolean> {
  if (!(await loc.isVisible({ timeout: 500 }).catch(() => false))) return false;
  await loc.click({ force: true }).catch(() => undefined);
  await loc.evaluate((el, v) => {
    const node = el as HTMLElement;
    node.focus();
    node.textContent = v;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  return true;
}

async function uploadResumeIfNeeded(drawer: Locator): Promise<boolean> {
  const resume = naukriResumePath();
  if (!resume) return false;
  const file = drawer.locator('input.chatbot_Uploader[type="file"], input[type="file"]').first();
  if (!(await file.count().catch(() => 0))) return false;
  // File inputs are often hidden — still set files
  try {
    await file.setInputFiles(resume);
    console.log(`  Uploaded resume: ${resume}`);
    return true;
  } catch {
    return false;
  }
}

async function clickChatbotSave(drawer: Locator): Promise<boolean> {
  const btns = [
    drawer.locator("div.sendMsg"),
    drawer.locator(".sendMsgbtn_container .sendMsg"),
    drawer.locator(".sendMsgbtn_container"),
    drawer.locator(".footerWrapper button:has-text('Save')"),
    drawer.locator("button:has-text('Save')"),
    drawer.locator("button:has-text('Submit')"),
    drawer.locator("button:has-text('Send')"),
  ];
  for (const b of btns) {
    const el = b.first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      const disabled = await el.isDisabled().catch(() => false);
      if (disabled) continue;
      await naukriDelay("click");
      // Real click (no force) so chatbot JS handlers fire
      await el.click({ timeout: 3000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function lastBotQuestion(drawer: Locator): Promise<string> {
  const msgs = drawer.locator(".botMsg");
  const n = await msgs.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const t = ((await msgs.nth(i).textContent().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) continue;
    if (
      /thank you for showing interest|kindly answer|successfully apply/i.test(t) &&
      !/\?/.test(t)
    ) {
      continue;
    }
    return t;
  }
  return "";
}

/** One round of Naukri chatbot Q&A (drawer on the right). */
async function answerChatbotRound(
  page: Page,
  profile: ProfileAnswers,
  opts?: { dryRun?: boolean; lastLabel?: string },
): Promise<"answered" | "done" | "idle" | { status: "answered"; label: string }> {
  const drawer = chatbotDrawer(page);
  if (!(await drawer.isVisible({ timeout: 1500 }).catch(() => false))) {
    return "idle";
  }

  // Success / done states
  const done = drawer.locator(
    "text=/applied successfully|application (sent|submitted)|thank you for applying|you have applied/i",
  );
  if (await done.first().isVisible({ timeout: 600 }).catch(() => false)) {
    return "done";
  }

  const label = await lastBotQuestion(drawer);
  if (opts?.lastLabel && label && label === opts.lastLabel) {
    // Same question still showing — Save may not have registered yet
    await page.waitForTimeout(800);
  }

  const hasRadios = await drawer
    .locator("input.ssrc__radio, .singleselect-radiobutton")
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);
  const sendVisible = await drawer
    .locator(".chatbot_SendMessageContainer:not(.d-none) .textArea, .textArea[contenteditable='true']")
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  // File input often exists hidden in the drawer — only treat as upload when asked
  const needsFile = /resume|cv|upload|attach/i.test(label);

  if (!label && !hasRadios && !sendVisible && !needsFile) {
    return "idle";
  }

  const answer = answerForQuestion(label || "Are you interested?", profile);
  console.log(
    `  Q: "${(label || "(controls)").slice(0, 100)}" → ${answer.type}${
      answer.type === "yesNo"
        ? `=${answer.yes ? "Yes" : "No"}`
        : answer.type === "skip"
          ? ""
          : `=${answer.value}`
    }`,
  );

  if (answer.type === "skip" && !hasRadios) {
    return "idle";
  }

  let acted = false;

  if (hasRadios) {
    const yes =
      answer.type === "yesNo" ? answer.yes : profile.defaultYes;
    acted = await clickYesNoIn(drawer, yes);
  } else if (answer.type === "text" && answer.value === "__RESUME__") {
    acted = await uploadResumeIfNeeded(drawer);
  } else if (sendVisible) {
    const value =
      answer.type === "text" || answer.type === "number"
        ? answer.value
        : answer.type === "yesNo"
          ? answer.yes
            ? "Yes"
            : "No"
          : profile.defaultText;
    const textArea = drawer
      .locator(
        ".chatbot_SendMessageContainer:not(.d-none) .textArea[contenteditable='true'], .textArea[contenteditable='true']",
      )
      .first();
    acted = await fillContentEditable(textArea, value);
  } else if (needsFile) {
    acted = await uploadResumeIfNeeded(drawer);
  } else {
    // Fallback: any visible text input inside drawer
    const input = drawer
      .locator(
        'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea',
      )
      .first();
    if (await input.isVisible({ timeout: 400 }).catch(() => false)) {
      const value =
        answer.type === "text" || answer.type === "number"
          ? answer.value
          : profile.defaultText;
      acted = await fillNativeInput(input, value);
    }
  }

  if (!acted) return "idle";

  if (opts?.dryRun) {
    console.log("  [dry-run] Would click Save on chatbot answer");
    return { status: "answered", label };
  }

  await naukriDelay("click");
  const saved = await clickChatbotSave(drawer);
  if (saved) {
    await page.waitForTimeout(2000);
  }
  return { status: "answered", label };
}

async function clickContinue(page: Page): Promise<boolean> {
  const btns = [
    page.getByRole("button", {
      name: /save and (send|apply|continue)|submit|apply now|confirm|continue|next|done|finish/i,
    }),
    page.locator('button:has-text("Save and send")'),
    page.locator('button:has-text("Submit")'),
    page.locator('button:has-text("Apply now")'),
    page.locator('button:has-text("Continue")'),
    page.locator('button:has-text("Next")'),
  ];
  for (const b of btns) {
    const el = b.first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      const disabled = await el.isDisabled().catch(() => false);
      if (disabled) continue;
      await naukriDelay("click");
      await el.click({ force: true }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

/**
 * Detect questionnaire UI and fill answers. Returns how many fields answered.
 */
export async function fillNaukriQuestionnaire(
  page: Page,
  opts?: { dryRun?: boolean; maxRounds?: number },
): Promise<{ answered: number; submitted: boolean; stalled?: boolean }> {
  const profile = loadProfileAnswers();
  const maxRounds = opts?.maxRounds ?? 12;
  let answered = 0;
  let submitted = false;
  let stalled = false;

  await page.waitForTimeout(1200);

  // Primary path: Naukri apply chatbot drawer
  let lastLabel = "";
  let sameLabelStreak = 0;
  for (let round = 0; round < maxRounds; round++) {
    const drawerVisible = await chatbotDrawer(page)
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (!drawerVisible) break;

    const result = await answerChatbotRound(page, profile, {
      dryRun: opts?.dryRun,
      lastLabel,
    });
    if (result === "done") {
      submitted = true;
      break;
    }
    if (result === "idle") {
      if (!opts?.dryRun) {
        const clicked = await clickChatbotSave(chatbotDrawer(page));
        if (clicked) {
          submitted = true;
          await page.waitForTimeout(1200);
          continue;
        }
      }
      break;
    }

    // answered
    const label =
      typeof result === "object" && result.status === "answered"
        ? result.label
        : "";
    answered += 1;
    submitted = !opts?.dryRun;
    if (opts?.dryRun) break;

    if (label && label === lastLabel) {
      sameLabelStreak += 1;
      if (sameLabelStreak >= 2) {
        console.log("  Questionnaire stalled on same question — stopping");
        stalled = true;
        break;
      }
    } else {
      sameLabelStreak = 0;
    }
    lastLabel = label;
  }

  if (answered > 0 || opts?.dryRun) {
    return { answered, submitted, stalled };
  }

  // Legacy modal / form fallback (non-chatbot)
  const root = page
    .locator(
      [
        '[class*="questionnaire"]',
        '[class*="apply-form"]',
        '[role="dialog"]',
        ".lightbox",
        "#apply-modal",
      ].join(", "),
    )
    .first();
  const hasRoot = await root.isVisible({ timeout: 800 }).catch(() => false);
  if (!hasRoot) return { answered, submitted, stalled };

  const labels = root.locator("label, .botMsg, h3, h4");
  const ln = Math.min(await labels.count().catch(() => 0), 20);
  for (let i = 0; i < ln; i++) {
    const lab = labels.nth(i);
    if (!(await lab.isVisible().catch(() => false))) continue;
    const text = ((await lab.textContent()) || "").trim();
    if (text.length < 3) continue;
    const answer = answerForQuestion(text, profile);
    if (answer.type === "skip") continue;
    const block = lab.locator("xpath=..");
    if (answer.type === "yesNo") {
      if (await clickYesNoIn(block, answer.yes)) answered += 1;
    } else {
      const input = block
        .locator(
          'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select',
        )
        .first();
      if (
        await fillNativeInput(
          input,
          answer.type === "text" || answer.type === "number"
            ? answer.value
            : profile.defaultText,
        )
      ) {
        answered += 1;
      }
    }
    await naukriDelay("click");
  }

  if (!opts?.dryRun && answered > 0) {
    submitted = await clickContinue(page);
  }

  return { answered, submitted, stalled };
}

/** True if Naukri apply chatbot / screening UI is visible. */
export async function hasQuestionnaireUi(page: Page): Promise<boolean> {
  const drawer = chatbotDrawer(page);
  if (await drawer.isVisible({ timeout: 1500 }).catch(() => false)) {
    const signal = drawer.locator(
      ".botMsg, input.ssrc__radio, .singleselect-radiobutton, .chatbot_MessageContainer",
    );
    if (await signal.first().isVisible({ timeout: 800 }).catch(() => false)) {
      return true;
    }
  }
  const hint = page
    .locator(
      "text=/answer a few questions|mandatory questions|recruiter'?s questions|kindly answer/i",
    )
    .first();
  return hint.isVisible({ timeout: 600 }).catch(() => false);
}
