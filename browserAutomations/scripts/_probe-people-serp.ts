import { chromium } from "playwright";
import { unwrapSearchRedirect } from "../lib/leads/web.js";

async function probe(engine: "bing" | "ddg", q: string) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  });
  const url =
    engine === "ddg"
      ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
      : `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 2500));
  const title = await page.title();
  const anchorCount = await page.locator("a").count();
  const body = (await page.locator("body").innerText()).slice(0, 800);
  const raw = (await page.evaluate(`(() => {
    return Array.from(document.querySelectorAll("a[href]")).slice(0, 40).map((a) => ({
      href: a.getAttribute("href") || "",
      text: (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
    }));
  })()`)) as Array<{ href: string; text: string }>;

  const li = raw
    .map((r) => {
      let href = r.href;
      if (href.startsWith("/ck/")) href = `https://www.bing.com${href}`;
      if (href.startsWith("/l/?")) href = `https://duckduckgo.com${href}`;
      return { ...r, final: unwrapSearchRedirect(href) };
    })
    .filter(
      (r) =>
        /linkedin\.com\/in\//i.test(r.href) ||
        /linkedin\.com\/in\//i.test(r.final) ||
        /linkedin\.com\/in\//i.test(r.text),
    );

  console.log(`\n=== ${engine} ===`);
  console.log("title=", title);
  console.log("anchors=", anchorCount);
  console.log("body=", body.replace(/\n/g, " | ").slice(0, 400));
  console.log("li hits=", li.length);
  console.log(JSON.stringify(li.slice(0, 5), null, 2));
  console.log(
    "first hrefs=",
    raw.slice(0, 8).map((r) => r.href.slice(0, 90)),
  );
  await browser.close();
}

const q =
  '"Aloyoga" (CEO OR CTO OR Founder) site:linkedin.com/in';
const q2 = "Aloyoga CEO Founder site:linkedin.com/in";
await probe("bing", q);
await probe("ddg", q);
await probe("bing", q2);
await probe("ddg", q2);
