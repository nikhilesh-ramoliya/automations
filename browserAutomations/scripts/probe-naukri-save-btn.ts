/**
 * Debug: Yes + click sendMsg, watch for next question.
 */
import "dotenv/config";
import { withNaukriPage } from "../lib/naukri/browser.js";
import { gotoNaukriWithRetry } from "../lib/auth-naukri.js";

const JOB_URL =
  "https://www.naukri.com/job-listings-full-stack-developer-saraca-solutions-bengaluru-3-to-5-years-210826028103";

async function botText(page: import("playwright").Page) {
  const msgs = page.locator(".chatbot_Drawer .botMsg");
  const n = await msgs.count();
  const texts: string[] = [];
  for (let i = 0; i < n; i++) {
    texts.push(((await msgs.nth(i).textContent()) || "").replace(/\s+/g, " ").trim());
  }
  return texts;
}

async function main() {
  await withNaukriPage(
    async (page) => {
      await gotoNaukriWithRetry(page, JOB_URL, "probe");
      await page.waitForTimeout(2000);
      await page.locator("#apply-button").first().click();
      await page.waitForTimeout(2500);

      const drawer = page.locator(".chatbot_Drawer").first();
      console.log("before", await botText(page));

      // Prefer label click only (no check())
      await drawer.locator("label.ssrc__label[for='Yes']").click();
      await page.waitForTimeout(500);
      console.log("checked", await drawer.locator("#Yes").isChecked());

      // Try several Save click strategies
      const strategies = [
        async () => drawer.locator("div.sendMsg").click(),
        async () => drawer.locator(".sendMsgbtn_container").click(),
        async () => drawer.locator("div.send").click(),
        async () => {
          await drawer.locator("div.sendMsg").focus();
          await page.keyboard.press("Enter");
        },
        async () => {
          await drawer.locator("div.sendMsg").evaluate((el) => {
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          });
        },
      ];

      for (let i = 0; i < strategies.length; i++) {
        console.log("strategy", i);
        await strategies[i]!();
        await page.waitForTimeout(2500);
        const texts = await botText(page);
        console.log("after", texts.slice(-4));
        if (texts.length > 2 && !texts[texts.length - 1]?.includes("relocate")) {
          console.log("ADVANCED!");
          break;
        }
        // re-select yes if UI reset
        if (await drawer.locator("label.ssrc__label[for='Yes']").isVisible().catch(() => false)) {
          await drawer.locator("label.ssrc__label[for='Yes']").click().catch(() => undefined);
          await page.waitForTimeout(300);
        }
      }

      await page.waitForTimeout(4000);
    },
    { jobId: "naukri-probe-save2", headless: false },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
