/**
 * Apply to a Naukri job listing (site apply + screening questions).
 */

import type { Page } from "playwright";
import { assertNotNaukriLogin } from "./browser.js";
import {
  fillNaukriQuestionnaireViaAgent,
  naukriQuestionnaireMode,
  shouldUseAgentQuestionnaire,
} from "./agent-questionnaire.js";
import {
  fillNaukriQuestionnaire,
  hasQuestionnaireUi,
} from "./questionnaire.js";
import {
  assertJobRuntime,
  assertWithinCap,
  naukriDelay,
  recordAction,
} from "./safety.js";
import type { NaukriApplyResult } from "./types.js";

export type ApplyOutcome =
  | {
      ok: true;
      action: NaukriApplyResult["action"];
      detail?: string;
    }
  | { ok: false; action: "error" | "skip"; detail: string };

async function dismissOverlays(page: Page): Promise<void> {
  // Never click .crossIcon here — that closes the Naukri apply chatbot drawer.
  for (const sel of [
    'button:has-text("Got it")',
    'button:has-text("Maybe later")',
    '[aria-label="close"]:not(.chatBot-ic-cross)',
  ]) {
    const b = page.locator(sel).first();
    if (await b.isVisible({ timeout: 500 }).catch(() => false)) {
      await b.click().catch(() => undefined);
      await naukriDelay("click");
    }
  }
}

/**
 * Visit job URL and attempt Naukri apply (including Q&A when shown).
 * Dry-run: finds controls / fills answers but does not confirm final submit.
 */
export async function applyToNaukriJob(
  page: Page,
  opts: {
    jobUrl: string;
    dryRun: boolean;
    skipExternal: boolean;
  },
): Promise<ApplyOutcome> {
  assertJobRuntime();
  assertWithinCap("page_view");
  assertWithinCap("apply");

  const { gotoNaukriWithRetry } = await import("../auth-naukri.js");
  await gotoNaukriWithRetry(page, opts.jobUrl, "job apply");
  await naukriDelay("nav");
  assertNotNaukriLogin(page, "naukri apply");
  recordAction("page_view");
  await dismissOverlays(page);

  // Already applied?
  const already = page
    .locator(
      'button:has-text("Applied"), span:has-text("Applied"), div:has-text("Applied")',
    )
    .filter({ hasText: /^applied$/i })
    .first();
  if (await already.isVisible({ timeout: 1500 }).catch(() => false)) {
    return { ok: true, action: "already_applied", detail: "already_applied" };
  }

  const externalBtn = page
    .getByRole("button", { name: /apply on company (site|website)/i })
    .or(page.getByRole("link", { name: /apply on company (site|website)/i }))
    .or(page.locator('a:has-text("Apply on company website")'))
    .first();

  const applyBtn = page
    .getByRole("button", { name: /^apply$/i })
    .or(page.locator('button:has-text("Apply")').filter({ hasNotText: /company/i }))
    .or(
      page.locator(
        '#apply-button, button#apply-button, .apply-button, button[class*="apply-button"]',
      ),
    )
    .first();

  const hasExternal = await externalBtn
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  const hasApply = await applyBtn.isVisible({ timeout: 2000 }).catch(() => false);

  if (!hasApply && hasExternal) {
    if (opts.skipExternal) {
      return {
        ok: true,
        action: "external",
        detail: "external_only_skipped",
      };
    }
    if (opts.dryRun) {
      console.log(`[naukri dry-run] Would open company site apply: ${opts.jobUrl}`);
      return { ok: true, action: "external", detail: "dry_run_external" };
    }
    await naukriDelay("apply_think");
    await externalBtn.click();
    recordAction("apply");
    return { ok: true, action: "external", detail: "opened_company_site" };
  }

  if (!hasApply) {
    return {
      ok: false,
      action: "skip",
      detail: "apply_button_not_found",
    };
  }

  await naukriDelay("apply_think");
  await applyBtn.click();
  await naukriDelay("click");
  await dismissOverlays(page);

  // Screening questions / chatbot Q&A
  // Modes: scripted | agent (Cursor SDK) | auto (scripted then SDK on stall)
  let qDetail = "";
  let hasQ = await hasQuestionnaireUi(page);
  if (!hasQ) {
    await page.waitForTimeout(1500);
    hasQ = await hasQuestionnaireUi(page);
  }

  if (hasQ) {
    const mode = naukriQuestionnaireMode();
    console.log(
      `  Screening questions detected — mode=${mode} (NAUKRI_QUESTIONNAIRE_MODE)`,
    );

    let scripted: {
      answered: number;
      submitted: boolean;
      stalled?: boolean;
    } | null = null;

    if (mode !== "agent") {
      console.log("  Filling from NAUKRI_PROFILE_* (scripted)…");
      scripted = await fillNaukriQuestionnaire(page, {
        dryRun: opts.dryRun,
        maxRounds: 8,
      });
      qDetail = `scripted;questions_answered=${scripted.answered},submitted=${scripted.submitted},stalled=${Boolean(scripted.stalled)}`;
      console.log(`  Questionnaire (scripted): ${qDetail}`);
    }

    if (shouldUseAgentQuestionnaire(scripted ?? undefined)) {
      console.log("  Handing off in-app questions to Cursor Agent SDK…");
      const agentQ = await fillNaukriQuestionnaireViaAgent(page, {
        dryRun: opts.dryRun,
        jobUrl: opts.jobUrl,
      });
      qDetail = qDetail ? `${qDetail};${agentQ.detail}` : agentQ.detail;
      console.log(`  Questionnaire (agent): ${agentQ.detail}`);
    }
  }

  if (opts.dryRun) {
    console.log(`[naukri dry-run] Would finish apply: ${opts.jobUrl}`);
    await page.keyboard.press("Escape").catch(() => undefined);
    return {
      ok: true,
      action: "naukri_apply",
      detail: qDetail ? `dry_run;${qDetail}` : "dry_run",
    };
  }

  // Final confirm if still present
  const confirm = page
    .getByRole("button", {
      name: /save and (send|apply)|submit|apply now|confirm|finish/i,
    })
    .or(page.locator('button:has-text("Save and send")'))
    .or(page.locator('button:has-text("Apply now")'))
    .first();

  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
    const disabled = await confirm.isDisabled().catch(() => false);
    if (!disabled) {
      await naukriDelay("click");
      await confirm.click();
      await naukriDelay("between");
    }
  }

  recordAction("apply");

  const appliedOk = await page
    .locator(
      'text=/applied successfully|application sent|you have applied|application submitted/i',
    )
    .first()
    .isVisible({ timeout: 6000 })
    .catch(() => false);

  return {
    ok: true,
    action: "naukri_apply",
    detail: appliedOk
      ? qDetail
        ? `applied;${qDetail}`
        : "applied"
      : qDetail
        ? `clicked_apply;${qDetail}`
        : "clicked_apply",
  };
}
