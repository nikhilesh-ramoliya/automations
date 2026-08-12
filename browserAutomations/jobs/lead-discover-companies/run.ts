import "dotenv/config";
import path from "node:path";
import type { Page } from "playwright";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath, type LogEvent } from "../../lib/logging.js";
import { assertNotLogin, hasLinkedInAuth, withLinkedInPage } from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import {
  cleanCompanyName,
  companyNameFromLinkedInSlug,
  isGenuineCompanyName,
  leadMinCompanyScore,
  normalizeLinkedInCompanyUrl,
  passesLeadGate,
  sanitizeScrapedCompany,
  withIcpAnnotation,
} from "../../lib/leads/company-quality.js";
import {
  allowLeadSeeds,
  envInt,
  isLeadDryRun,
  leadDelayMs,
  leadGeos,
  leadIndustries,
  leadKeywords,
  snapshotConfigFromEnv,
} from "../../lib/leads/env.js";
import {
  SafetyLimitError,
  assertJobRuntime,
  assertWithinCap,
  humanDelay,
  recordAction,
} from "../../lib/linkedin-safety.js";
import {
  ARTIFACTS,
  type CompanyRecord,
} from "../../lib/leads/types.js";
import {
  artifactPath,
  ensureRunMeta,
  normalizeCompanyName,
  resolveRunDir,
  slugId,
  writeJson,
} from "../../lib/leads/io.js";
import { officialSiteSearchHint } from "../../lib/leads/web.js";

type ScrapedCompany = {
  name: string;
  linkedinUrl?: string;
  websiteUrlHint?: string;
  industry?: string;
  location?: string;
  description?: string;
};

const SEED_COMPANIES: ScrapedCompany[] = [
  {
    name: "Acme Manufacturing Co",
    linkedinUrl: "https://www.linkedin.com/company/example-acme-mfg/",
    websiteUrlHint: "https://example.com",
    industry: "Manufacturing",
    location: "United States",
    description:
      "Industrial manufacturer exploring digital transformation and automation.",
  },
  {
    name: "Northstar Logistics",
    linkedinUrl: "https://www.linkedin.com/company/example-northstar/",
    websiteUrlHint: "https://www.example.org",
    industry: "Logistics",
    location: "United States",
    description:
      "Regional logistics firm modernizing operations and cloud systems.",
  },
  {
    name: "BrightPath Health",
    linkedinUrl: "https://www.linkedin.com/company/example-brightpath/",
    websiteUrlHint: "https://www.iana.org",
    industry: "Healthcare",
    location: "United States",
    description:
      "Healthcare services provider evaluating custom software and integrations.",
  },
];

function buildSearchUrl(keywords: string[], geos: string[], industries: string[]): string {
  // Prefer buyer industries + transformation terms (avoid peer IT-shop-only results)
  const transformKw = keywords.filter((k) =>
    /digital|automation|legacy|erp|cloud|transformation|software/i.test(k),
  );
  const parts = [
    ...industries.slice(0, 2),
    ...transformKw.slice(0, 3),
    ...geos.slice(0, 1),
  ];
  if (parts.length < 3) parts.push(...keywords.slice(0, 3));
  const q = encodeURIComponent(parts.join(" ") || "manufacturing digital transformation");
  // Mid-market+ company sizes: C=51-200, D=201-500, E=501-1000, F=1001-5000, G=5001-10000
  const size = encodeURIComponent('["C","D","E","F"]');
  return (
    `https://www.linkedin.com/search/results/companies/?keywords=${q}` +
    `&companySize=${size}&origin=FACETED_SEARCH`
  );
}

async function scrapeCompanySearch(
  page: Page,
  searchUrl: string,
  scrapeCap: number,
  delayMs: number,
): Promise<ScrapedCompany[]> {
  assertJobRuntime();
  assertWithinCap("search");
  assertWithinCap("page_view");
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay("search", { minMs: delayMs });
  assertNotLogin(page, "company search");
  recordAction("search");
  recordAction("page_view");

  // Scroll a bit for lazy results — pause as if scanning cards
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1200);
    await humanDelay(i === 0 ? "read_card" : "idle_micro", { minMs: 400 });
  }

  const raw = (await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();
    const cleanName = (s) =>
      (s || "")
        .replace(/\\u00a0/g, " ")
        .replace(/\\s+/g, " ")
        .replace(/\\bFollow\\b.*$/i, "")
        .replace(/\\bMessage\\b.*$/i, "")
        .replace(/\\bConnect\\b.*$/i, "")
        .replace(/\\b\\d[\\d,]*(?:\\+)?\\s*(?:followers?|employees?)\\b.*$/i, "")
        .replace(/\\s*[·•|]\\s*.*$/, "")
        .trim();

    const anchors = Array.from(
      document.querySelectorAll('a[href*="/company/"]'),
    );
    for (const a of anchors) {
      const href = a.href || "";
      if (!/linkedin\\.com\\/company\\//i.test(href)) continue;
      if (/\\/company\\/\\d+\\/(admin|posts|jobs)/i.test(href)) continue;
      const m = href.match(/linkedin\\.com\\/company\\/([^/?#]+)/i);
      if (!m) continue;
      const slug = decodeURIComponent(m[1]).toLowerCase();
      if (seen.has(slug)) continue;
      if (/^school$|^showcase$/i.test(slug)) continue;

      const card =
        a.closest("li") ||
        a.closest('[data-chameleon-result-urn]') ||
        a.closest(".entity-result") ||
        a.parentElement;

      const titleEl =
        (card &&
          card.querySelector(
            ".entity-result__title-text a span[aria-hidden='true'], .entity-result__title-text span[aria-hidden='true'], .entity-result__title-text span[dir='ltr'], h3 span[aria-hidden='true']",
          )) ||
        null;
      let name = cleanName((titleEl && titleEl.textContent) || "");
      if (!name || name.length < 2) {
        name = cleanName(a.getAttribute("aria-label") || "");
      }
      if (!name || name.length < 2) {
        name = cleanName(a.textContent || "");
      }
      // LinkedIn sometimes duplicates the name in accessible text
      if (name) {
        const half = Math.floor(name.length / 2);
        if (half > 3 && name.slice(0, half).trim() === name.slice(half).trim()) {
          name = name.slice(0, half).trim();
        }
      }
      // Prefer slug title when card text is still mashed
      const slugTitle = slug
        .split("-")
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      if (
        !name ||
        name.length > 70 ||
        /\\bFollow\\b|IT Services and IT Consulting|Information Technology/i.test(name)
      ) {
        name = slugTitle;
      }
      if (!name || name.length < 2) continue;
      if (/^linkedin$/i.test(name)) continue;
      if (/^page\\s+by\\b/i.test(name)) continue;
      if (/^(follow|message|connect)$/i.test(name)) continue;

      const text = ((card && card.textContent) || "")
        .replace(/\\s+/g, " ")
        .trim();
      const primary = (card &&
        card.querySelector(
          ".entity-result__primary-subtitle, .entity-result__summary",
        )) ||
        null;
      let industry = cleanName(
        (primary && primary.textContent) || "",
      ).slice(0, 80);
      if (/\\bFollow\\b/i.test(industry) || industry.length < 2) industry = "";

      seen.add(slug);
      out.push({
        name: name.slice(0, 120),
        linkedinUrl: "https://www.linkedin.com/company/" + slug + "/",
        description: text.slice(0, 240) || undefined,
        industry: industry || undefined,
      });
      if (out.length >= 40) break;
    }
    return out;
  })()`)) as ScrapedCompany[];

  return raw.slice(0, scrapeCap);
}

function toRecords(
  scraped: ScrapedCompany[],
  source: CompanyRecord["source"],
): CompanyRecord[] {
  const now = new Date().toISOString();
  return scraped.map((c, i) => {
    const websiteHint = (c as { websiteUrlHint?: string }).websiteUrlHint;
    const li = normalizeLinkedInCompanyUrl(c.linkedinUrl);
    const sanitized = sanitizeScrapedCompany(c);
    const slug = li?.match(/\/company\/([^/]+)/i)?.[1] ?? "";
    const name =
      sanitized?.name ||
      cleanCompanyName(c.name) ||
      companyNameFromLinkedInSlug(slug) ||
      c.name;
    return {
      id: slugId("co", `${name}-${i}`),
      name,
      normalizedName: normalizeCompanyName(name),
      linkedinUrl: li || c.linkedinUrl,
      websiteUrl: websiteHint,
      websiteSearchHint: officialSiteSearchHint(name),
      industry: sanitized?.industry ?? c.industry,
      location: c.location,
      description: sanitized?.description ?? c.description,
      source,
      discoveredAt: now,
      notes: ["web_first_enrich_path"],
    };
  });
}

function filterByQuality(
  companies: CompanyRecord[],
  minScore: number,
  keywords: string[],
  industries: string[],
  log: (e: LogEvent) => void,
): CompanyRecord[] {
  const kept: CompanyRecord[] = [];
  const seenUrls = new Set<string>();
  const seenNames = new Set<string>();

  for (const c of companies) {
    const sanitized = sanitizeScrapedCompany(c);
    if (!sanitized) {
      const reason = isGenuineCompanyName(c.name).reason ?? "sanitize_failed";
      log({
        ts: new Date().toISOString(),
        type: "company_rejected",
        name: c.name,
        reason,
        stage: "discover",
      });
      console.log(`  ✗ reject ${c.name} (${reason})`);
      continue;
    }

    const li = normalizeLinkedInCompanyUrl(sanitized.linkedinUrl);
    if (sanitized.linkedinUrl && !li) {
      log({
        ts: new Date().toISOString(),
        type: "company_rejected",
        name: sanitized.name,
        reason: "malformed_linkedin_url",
        stage: "discover",
      });
      console.log(`  ✗ reject ${sanitized.name} (malformed_linkedin_url)`);
      continue;
    }
    if (li) {
      if (seenUrls.has(li)) {
        log({
          ts: new Date().toISOString(),
          type: "company_rejected",
          name: sanitized.name,
          reason: "duplicate_linkedin_url",
          stage: "discover",
        });
        continue;
      }
      seenUrls.add(li);
    }

    const norm = normalizeCompanyName(sanitized.name);
    if (seenNames.has(norm)) {
      log({
        ts: new Date().toISOString(),
        type: "company_rejected",
        name: sanitized.name,
        reason: "duplicate_name",
        stage: "discover",
      });
      continue;
    }
    seenNames.add(norm);

    const record: CompanyRecord = {
      ...c,
      name: sanitized.name,
      normalizedName: norm,
      linkedinUrl: li || undefined,
      industry: sanitized.industry ?? c.industry,
      description: sanitized.description ?? c.description,
    };

    // Discover stage: genuineness is hard; ICP score is soft-ranked (enrich tightens).
    // Still require a floor so pure junk / weak ICP doesn't flood the pipeline.
    const discoverFloor = Math.min(minScore, 35);
    const gate = passesLeadGate(record, discoverFloor, { keywords, industries });
    const annotated = withIcpAnnotation(record, gate);

    if (!gate.pass) {
      log({
        ts: new Date().toISOString(),
        type: "company_rejected",
        name: annotated.name,
        reason: gate.reasons.join("|") || "below_icp",
        score: gate.score,
        stage: "discover",
      });
      console.log(
        `  ✗ reject ${annotated.name} (score=${gate.score}: ${gate.reasons.join(", ")})`,
      );
      continue;
    }

    log({
      ts: new Date().toISOString(),
      type: "company_accepted",
      name: annotated.name,
      score: gate.score,
      signals: gate.signals.slice(0, 6),
      stage: "discover",
    });
    console.log(
      `  ✓ ${annotated.name} (icp=${gate.score}${annotated.industry ? `, ${annotated.industry}` : ""})`,
    );
    kept.push(annotated);
  }

  // Prefer higher ICP scores when truncating to max
  kept.sort((a, b) => {
    const sa = Number(
      (a.notes ?? []).find((n) => n.startsWith("icp_score:"))?.split(":")[1] ?? 0,
    );
    const sb = Number(
      (b.notes ?? []).find((n) => n.startsWith("icp_score:"))?.split(":")[1] ?? 0,
    );
    return sb - sa;
  });
  return kept;
}

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "lead-discover-companies",
    });
  }

  const dryRun = isLeadDryRun();
  const maxCompanies = envInt("LEAD_MAX_COMPANIES", 10);
  const keywords = leadKeywords();
  const geos = leadGeos();
  const industries = leadIndustries();
  const minCompanyScore = leadMinCompanyScore();
  const delayMs = leadDelayMs();
  const config = snapshotConfigFromEnv();

  const { runId, runDir } = resolveRunDir({ createIfMissing: true });
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-discover-companies");
  const writer = createJsonlLogger(logPath);
  const relativeLog = path.relative(process.cwd(), logPath);

  writer.log({
    ts: new Date().toISOString(),
    type: "run_start",
    runId,
    dryRun,
    maxCompanies,
    minCompanyScore,
    keywords,
    geos,
    industries,
  });

  console.log("\n════════════════════════════════════════");
  console.log(" Lead discover companies");
  console.log(` Run:      ${runId}`);
  console.log(` Max:      ${maxCompanies}`);
  console.log(` ICP min:  ${minCompanyScore} (discover floor ≤35)`);
  console.log(` Dry-run:  ${dryRun}`);
  console.log(` Keywords: ${keywords.join(", ") || "(default)"}`);
  console.log(` Log:      ${relativeLog}`);
  console.log("════════════════════════════════════════\n");

  let companies: CompanyRecord[] = [];
  let sourceNote = "linkedin";
  const seedsAllowed = allowLeadSeeds();

  try {
    if (!hasLinkedInAuth()) {
      throw new Error("Missing LinkedIn session. Run `npm run auth:linkedin` first.");
    }

    const searchUrl = buildSearchUrl(keywords, geos, industries);
    writer.log({
      ts: new Date().toISOString(),
      type: "navigation",
      url: searchUrl,
      allowSeeds: seedsAllowed,
    });

    try {
      // Over-scrape so genuineness + ICP filter can still fill maxCompanies
      const scrapeCap = Math.min(40, Math.max(maxCompanies * 4, maxCompanies + 8));
      const scraped = await withLinkedInPage(
        async (page) => {
          return scrapeCompanySearch(page, searchUrl, scrapeCap, delayMs);
        },
        { jobId: "lead-discover-companies" },
      );
      const rawRecords = toRecords(scraped, "linkedin");
      writer.log({
        ts: new Date().toISOString(),
        type: "scraped",
        count: rawRecords.length,
      });
      console.log(`Scraped ${rawRecords.length} raw cards — applying quality gate…`);
      companies = filterByQuality(
        rawRecords,
        minCompanyScore,
        keywords,
        industries,
        writer.log,
      );
    } catch (err) {
      if (err instanceof SafetyLimitError) {
        writer.log({
          ts: new Date().toISOString(),
          type: "safety_limit",
          message: err.message,
        });
        console.warn(err.message);
        // Keep any partial results; do not invent seed companies
      } else {
        const message = err instanceof Error ? err.message : String(err);
        writer.log({
          ts: new Date().toISOString(),
          type: "scrape_failed",
          message,
        });
        console.warn(`LinkedIn scrape failed: ${message}`);
        if (/login|checkpoint|auth|restriction/i.test(message)) throw err;
      }
    }

    if (companies.length === 0) {
      if (!seedsAllowed) {
        writeJson(artifactPath(runDir, ARTIFACTS.companies), []);
        ensureRunMeta(runDir, runId, config, "lead-discover-companies");
        const failMsg =
          "No genuine LinkedIn companies discovered. " +
          "Refusing seed fallback (set LEAD_ALLOW_SEEDS=true only for local smoke tests). " +
          "Check session (`npm run auth:linkedin`), keywords/ICP filters, and LI_SAFE_* caps.";
        writer.log({
          ts: new Date().toISOString(),
          type: "discover_empty",
          message: failMsg,
        });
        console.error(`\n${failMsg}\n`);
        throw new Error(failMsg);
      }

      const seeds = SEED_COMPANIES.slice(0, Math.min(maxCompanies, SEED_COMPANIES.length));
      const seedRecords = toRecords(seeds, "seed");
      companies = filterByQuality(
        seedRecords,
        minCompanyScore,
        keywords,
        industries,
        writer.log,
      );
      if (companies.length === 0) {
        companies = seedRecords.map((c) => {
          const gate = passesLeadGate(c, 0, { keywords, industries });
          return withIcpAnnotation(c, { ...gate, pass: true });
        });
      }
      sourceNote = "seed";
      writer.log({
        ts: new Date().toISOString(),
        type: "seed_companies",
        count: companies.length,
        message:
          "LEAD_ALLOW_SEEDS=true — wrote sample companies. Do not use seeds for live outreach.",
      });
      console.warn(
        "LEAD_ALLOW_SEEDS=true — writing seed sample companies (not for live outreach).\n",
      );
    }

    companies = companies.slice(0, maxCompanies);
    writeJson(artifactPath(runDir, ARTIFACTS.companies), companies);
    ensureRunMeta(runDir, runId, config, "lead-discover-companies");

    writer.log({
      ts: new Date().toISOString(),
      type: "run_end",
      runId,
      count: companies.length,
      source: sourceNote,
      out: path.join(runDir, ARTIFACTS.companies),
    });

    console.log(`Wrote ${companies.length} companies → data/leads/${runId}/${ARTIFACTS.companies}`);
    for (const c of companies.slice(0, 15)) {
      const icp = (c.notes ?? []).find((n) => n.startsWith("icp_score:"))?.split(":")[1];
      console.log(
        `  • ${c.name}${c.industry ? ` (${c.industry})` : ""}${icp ? ` icp=${icp}` : ""} [source=${c.source}]`,
      );
    }
    console.log(`Log → ${relativeLog}\n`);

    return { exitCode: 0, message: `Discovered ${companies.length} companies (${sourceNote})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writer.log({ ts: new Date().toISOString(), type: "error", message });
    // Still persist empty artifact for downstream awareness
    if (!companies.length) {
      writeJson(artifactPath(runDir, ARTIFACTS.companies), []);
    }
    throw err;
  } finally {
    await writer.close();
  }
}
