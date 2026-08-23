/**
 * One-off: open a Naukri job, click Apply, dump Q&A DOM for selector fixes.
 * Usage: npx tsx scripts/probe-naukri-apply.ts [jobUrl]
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { withNaukriPage } from "../lib/naukri/browser.js";
import { gotoNaukriWithRetry } from "../lib/auth-naukri.js";

const JOB_URL =
  process.argv[2] ||
  "https://www.naukri.com/job-listings-full-stack-developer-saraca-solutions-bengaluru-3-to-5-years-210826028103";

const outDir = path.join("data", "naukri", "probe-apply");

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await withNaukriPage(
    async (page) => {
      await gotoNaukriWithRetry(page, JOB_URL, "probe");
      await page.waitForTimeout(2500);

      const applyBtn = page
        .getByRole("button", { name: /^apply$/i })
        .or(page.locator('button:has-text("Apply")').filter({ hasNotText: /company/i }))
        .or(page.locator("#apply-button, button#apply-button, .apply-button"))
        .first();

      console.log("URL:", page.url());
      console.log(
        "Apply visible:",
        await applyBtn.isVisible({ timeout: 5000 }).catch(() => false),
      );
      await applyBtn.click({ timeout: 10_000 });
      await page.waitForTimeout(3500);

      await page.screenshot({
        path: path.join(outDir, "after-apply.png"),
        fullPage: true,
      });

      // Use string form so tsx/esbuild does not inject __name into the browser bundle
      const dump = await page.evaluate(`(() => {
        function serialize(el, i) {
          const r = el.getBoundingClientRect();
          return {
            i,
            tag: el.tagName,
            id: el.id,
            className: String(el.className).slice(0, 200),
            role: el.getAttribute("role"),
            name: el.getAttribute("name"),
            type: el.getAttribute("type"),
            placeholder: el.getAttribute("placeholder"),
            ariaLabel: el.getAttribute("aria-label"),
            text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
            visible: r.width > 0 && r.height > 0,
          };
        }
        function pick(sel, limit) {
          return Array.from(document.querySelectorAll(sel))
            .slice(0, limit || 40)
            .map(serialize);
        }
        const dialogs = Array.from(
          document.querySelectorAll(
            '[role="dialog"], .modal, [class*="modal"], [class*="chatbot"], [class*="Chatbot"], [class*="questionnaire"], [class*="apply"], .lightbox',
          ),
        )
          .slice(0, 20)
          .map(function (el) {
            return {
              tag: el.tagName,
              className: String(el.className).slice(0, 240),
              id: el.id,
              text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 400),
              html: el.outerHTML.slice(0, 2500),
            };
          });
        return {
          title: document.title,
          url: location.href,
          inputs: pick(
            'input:not([type="hidden"]), textarea, select, [role="radio"], [role="checkbox"], button',
          ),
          labels: pick("label, [class*='question'], [class*='Question'], [class*='botMsg'], [class*='chatbot']"),
          dialogs: dialogs,
          bodySnippet: document.body.innerText.slice(0, 4000),
        };
      })()`);

      fs.writeFileSync(
        path.join(outDir, "dom.json"),
        JSON.stringify(dump, null, 2),
      );
      console.log("Wrote", path.join(outDir, "dom.json"));
      console.log("Body snippet:\n", dump.bodySnippet.slice(0, 1500));
      console.log(
        "Visible inputs:",
        dump.inputs.filter((x) => x.visible).slice(0, 30),
      );
      console.log("Dialog count:", dump.dialogs.length);
      for (const d of dump.dialogs.slice(0, 5)) {
        console.log("--- dialog ---", d.className.slice(0, 80));
        console.log(d.text.slice(0, 300));
      }

      // Keep browser open briefly for headed debug
      await page.waitForTimeout(2000);
    },
    { jobId: "naukri-probe", headless: false },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
