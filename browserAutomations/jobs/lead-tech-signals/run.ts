import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  withEphemeralBrowser,
  withEphemeralContextPage,
} from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import {
  envInt,
  isLeadDryRun,
  leadDelayMs,
  snapshotConfigFromEnv,
  webConcurrency,
} from "../../lib/leads/env.js";
import { humanDelay } from "../../lib/linkedin-safety.js";
import {
  artifactPath,
  ensureRunMeta,
  loadCompanies,
  readJson,
  resolveRunDir,
  writeJson,
} from "../../lib/leads/io.js";
import { mapPool } from "../../lib/leads/parallel.js";
import {
  ARTIFACTS,
  type CompanyRecord,
  type TechSignals,
} from "../../lib/leads/types.js";
import { crawlTechSignals } from "../../lib/leads/web.js";

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "lead-tech-signals",
    });
  }

  const dryRun = isLeadDryRun();
  const max = envInt("LEAD_MAX_COMPANIES", 10);
  const delayMs = leadDelayMs();
  const crawlMaxPages = envInt("LEAD_TECH_CRAWL_MAX_PAGES", 8);
  const concurrency = webConcurrency();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-tech-signals");
  const writer = createJsonlLogger(logPath);

  const companies = loadCompanies(runDir, "enriched").slice(0, max);
  if (companies.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.companiesTech), []);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No companies for tech signals.",
    };
  }

  console.log(
    `\nTech signals for ${companies.length} companies (run ${runId}, dryRun=${dryRun}) — ` +
      `site crawl (max ${crawlMaxPages} pages, concurrency=${concurrency})\n`,
  );

  const out: CompanyRecord[] = new Array(companies.length);

  await withEphemeralBrowser(async (browser) => {
    // Parallel only across different company origins (capped at 2). No SERP here.
    await mapPool(companies, concurrency, async (company, ci) => {
      const stackKeywords = new Set<string>(company.techKeywords ?? []);
      const vendorKeywords = new Set<string>();
      const buyingHints = new Set<string>();
      const rawSnippets: string[] = [];
      let careersMentionsHiring = false;
      let careersUrl = company.careersUrl;

      if (company.websiteUrl) {
        await withEphemeralContextPage(browser, async (page) => {
          const crawl = await crawlTechSignals(page, company.websiteUrl!, {
            maxPages: crawlMaxPages,
            careersUrl: company.careersUrl,
            delayMs,
          });

          for (const k of crawl.techKeywords) stackKeywords.add(k);
          for (const h of crawl.buyingHints) buyingHints.add(h);
          for (const s of crawl.rawSnippets) rawSnippets.push(s);
          careersUrl = careersUrl || crawl.careersUrl;
          careersMentionsHiring =
            careersMentionsHiring || crawl.careersMentionsHiring;

          for (const v of [
            "salesforce",
            "sap",
            "oracle",
            "hubspot",
            "servicenow",
            "shopify",
          ]) {
            if (crawl.techKeywords.includes(v)) vendorKeywords.add(v);
          }

          writer.log({
            ts: new Date().toISOString(),
            type: "crawl",
            name: company.name,
            startUrl: crawl.startUrl,
            pages: crawl.pagesVisited,
            okPages: crawl.pagesVisited.length,
            tech: crawl.techKeywords.length,
            usedFallbackPaths: crawl.usedFallbackPaths,
          });
        });
      }

      // Fall back to LinkedIn recent posts (from enrich harvest) when site crawl is thin
      const liPosts = company.techSignals?.fromLinkedInPosts
        ? company.techSignals
        : undefined;
      const harvestFile = readJson<{
        companies: Array<{
          companyId: string;
          postSnippets: string[];
          postKeywords: string[];
          buyingHints: string[];
          careersMentionsHiring?: boolean;
        }>;
      }>(artifactPath(runDir, ARTIFACTS.linkedinHarvest));
      const harvestRow = harvestFile?.companies?.find(
        (h) => h.companyId === company.id,
      );

      const needPostFallback =
        stackKeywords.size === 0 &&
        buyingHints.size === 0 &&
        !careersMentionsHiring;

      if (needPostFallback && (liPosts || harvestRow)) {
        const keywords = [
          ...(liPosts?.stackKeywords ?? []),
          ...(harvestRow?.postKeywords ?? []),
        ];
        const hints = [
          ...(liPosts?.buyingHints ?? []),
          ...(harvestRow?.buyingHints ?? []),
        ];
        const snippets = [
          ...(liPosts?.rawSnippets ?? []),
          ...(harvestRow?.postSnippets ?? []),
        ];
        for (const k of keywords) stackKeywords.add(k);
        for (const h of hints) buyingHints.add(h);
        for (const s of snippets) rawSnippets.push(s);
        careersMentionsHiring =
          careersMentionsHiring ||
          Boolean(liPosts?.careersMentionsHiring) ||
          Boolean(harvestRow?.careersMentionsHiring);
        buyingHints.add("linkedin_recent_posts");
        writer.log({
          ts: new Date().toISOString(),
          type: "linkedin_posts_fallback",
          name: company.name,
          keywords: keywords.length,
          snippets: snippets.length,
        });
        console.log(
          `  [posts] ${company.name}: fallback from LinkedIn posts (${keywords.length} keywords)`,
        );
      } else if (!company.websiteUrl && !needPostFallback) {
        // keep existing
      } else if (!company.websiteUrl) {
        const blob =
          `${company.description ?? ""} ${company.about ?? ""}`.toLowerCase();
        if (/hiring|career|job/.test(blob)) {
          careersMentionsHiring = true;
          buyingHints.add("text_mentions_hiring");
        }
        if (/cloud|aws|azure|devops/.test(blob)) {
          stackKeywords.add("cloud");
          buyingHints.add("text_mentions_cloud");
        }
        if (/automat|rpa|legacy|moderniz/.test(blob)) {
          buyingHints.add("text_mentions_automation_or_modernization");
        }
        writer.log({
          ts: new Date().toISOString(),
          type: "text_fallback",
          name: company.name,
        });
      }

      // Also merge any LinkedIn post signals even when site crawl found some
      if (!needPostFallback && (liPosts || harvestRow)) {
        for (const k of liPosts?.stackKeywords ?? []) stackKeywords.add(k);
        for (const k of harvestRow?.postKeywords ?? []) stackKeywords.add(k);
        for (const h of liPosts?.buyingHints ?? []) buyingHints.add(h);
        for (const h of harvestRow?.buyingHints ?? []) buyingHints.add(h);
      }

      const techSignals: TechSignals = {
        checkedAt: new Date().toISOString(),
        careersMentionsHiring,
        stackKeywords: [...stackKeywords],
        vendorKeywords: [...vendorKeywords],
        rawSnippets: rawSnippets.slice(0, 8),
        buyingHints: [...buyingHints],
        fromLinkedInPosts: Boolean(liPosts || harvestRow?.postSnippets?.length),
      };

      out[ci] = {
        ...company,
        careersUrl,
        techKeywords: [...stackKeywords],
        techSignals,
      };

      await humanDelay("between_companies", {
        minMs: Math.min(delayMs, 1500),
      });
    });
  });

  writeJson(artifactPath(runDir, ARTIFACTS.companiesTech), out);
  ensureRunMeta(runDir, runId, config, "lead-tech-signals");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    count: out.length,
  });
  console.log(
    `Wrote tech signals → data/leads/${runId}/${ARTIFACTS.companiesTech}`,
  );
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();
  return { exitCode: 0 };
}
