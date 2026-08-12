import "dotenv/config";
import path from "node:path";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath } from "../../lib/logging.js";
import {
  hasLinkedInAuth,
  withEphemeralBrowser,
  withEphemeralContextPage,
  withLinkedInPage,
} from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import {
  allowLeadSeeds,
  envInt,
  isLeadDryRun,
  leadDelayMs,
  peopleLinkedInCompany,
  peopleLinkedInSearch,
  peopleWebFirst,
  peopleWebSearch,
  snapshotConfigFromEnv,
  webConcurrency,
} from "../../lib/leads/env.js";
import {
  SafetyLimitError,
  humanDelay,
  remainingCap,
} from "../../lib/linkedin-safety.js";
import {
  artifactPath,
  ensureRunMeta,
  loadCompanies,
  readJson,
  resolveRunDir,
  slugId,
  writeJson,
} from "../../lib/leads/io.js";
import { mapPool } from "../../lib/leads/parallel.js";
import {
  type DiscoveredPerson,
  discoverPeopleFromLinkedInCompany,
  discoverPeopleFromLinkedInSearch,
  discoverPeopleFromWebSearch,
  discoverPeopleFromWebsite,
  mergePeople,
} from "../../lib/leads/people-discovery.js";
import {
  ARTIFACTS,
  type CompanyRecord,
  type LinkedInHarvestArtifact,
  type PersonRecord,
} from "../../lib/leads/types.js";
import { resetWebSearchBudget, isWebSearchSoftStopped } from "../../lib/leads/web.js";

function seedPeople(company: CompanyRecord, maxPeople: number): PersonRecord[] {
  const now = new Date().toISOString();
  const seeds = [
    { name: `Alex Rivera`, title: "CTO" },
    { name: `Jordan Lee`, title: "VP Engineering" },
    { name: `Sam Patel`, title: "Head of IT" },
  ].slice(0, maxPeople);

  return seeds.map((s, i) => ({
    id: slugId("pe", `${company.id}-${s.name}-${i}`),
    companyId: company.id,
    companyName: company.name,
    name: s.name,
    title: s.title,
    source: "seed" as const,
    discoveredAt: now,
  }));
}

function toPersonRecords(
  company: CompanyRecord,
  discovered: DiscoveredPerson[],
  now: string,
): PersonRecord[] {
  return discovered.map((s) => ({
    id: slugId("pe", `${company.id}-${s.name}`),
    companyId: company.id,
    companyName: company.name,
    name: s.name,
    title: s.title,
    linkedinUrl: s.linkedinUrl,
    email: s.email,
    location: s.location,
    source: s.source,
    discoveredAt: now,
  }));
}

function needsMore(found: DiscoveredPerson[], maxPeople: number): number {
  return Math.max(0, maxPeople - found.length);
}

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "lead-find-decision-makers",
    });
  }

  const dryRun = isLeadDryRun();
  const maxCompanies = envInt("LEAD_MAX_COMPANIES", 10);
  const maxPeople = envInt("LEAD_MAX_PEOPLE_PER_COMPANY", 3);
  const delayMs = leadDelayMs();
  const seedsAllowed = allowLeadSeeds();
  const webFirst = peopleWebFirst();
  const webSearch = peopleWebSearch();
  const liCompany = peopleLinkedInCompany();
  const liSearch = peopleLinkedInSearch();
  const concurrency = webConcurrency();
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);
  resetWebSearchBudget();

  const logPath = jobLogPath("lead-find-decision-makers");
  const writer = createJsonlLogger(logPath);

  const companies = loadCompanies(runDir, "best")
    .filter((c) => !c.suppressed)
    .slice(0, maxCompanies);

  if (companies.length === 0) {
    writeJson(artifactPath(runDir, ARTIFACTS.people), []);
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No companies for people search.",
    };
  }

  console.log(
    `\nFind decision makers for ${companies.length} companies ` +
      `(max ${maxPeople}/co, dryRun=${dryRun}, seeds=${seedsAllowed}, ` +
      `web=${webFirst}, webSearch=${webSearch}, liCompany=${liCompany}, ` +
      `liSearch=${liSearch}, siteConcurrency=${concurrency}, search=sequential)\n`,
  );

  const byCompany = new Map<string, DiscoveredPerson[]>();
  for (const c of companies) byCompany.set(c.id, []);
  const now = new Date().toISOString();

  // Reuse people collected during enrich LinkedIn harvest (same session About→People→Posts)
  const harvest = readJson<LinkedInHarvestArtifact>(
    artifactPath(runDir, ARTIFACTS.linkedinHarvest),
  );
  if (harvest?.companies?.length) {
    for (const h of harvest.companies) {
      if (!byCompany.has(h.companyId)) continue;
      const fromHarvest: DiscoveredPerson[] = (h.people ?? []).map((p) => ({
        name: p.name,
        title: p.title,
        linkedinUrl: p.linkedinUrl,
        source: p.source ?? "linkedin_company",
        rankScore: p.rankScore ?? 0,
      }));
      if (fromHarvest.length === 0) continue;
      byCompany.set(
        h.companyId,
        mergePeople(byCompany.get(h.companyId) ?? [], fromHarvest, maxPeople),
      );
      writer.log({
        ts: new Date().toISOString(),
        type: "people_from_harvest",
        company: h.companyName,
        count: fromHarvest.length,
      });
      console.log(
        `  [harvest] ${h.companyName}: ${fromHarvest.length} people (from LinkedIn session)`,
      );
    }
  }

  // --- 1. Website leadership crawl (low concurrency across company origins) ---
  if (webFirst) {
    const withSite = companies.filter((c) => Boolean(c.websiteUrl?.trim()));
    if (withSite.length > 0) {
      try {
        await withEphemeralBrowser(async (browser) => {
          await mapPool(withSite, concurrency, async (company) => {
            try {
              const { people, pagesVisited } = await withEphemeralContextPage(
                browser,
                async (page) =>
                  discoverPeopleFromWebsite(page, company, maxPeople),
              );
              const merged = mergePeople(
                byCompany.get(company.id) ?? [],
                people,
                maxPeople,
              );
              byCompany.set(company.id, merged);
              writer.log({
                ts: new Date().toISOString(),
                type: "people_website",
                company: company.name,
                count: people.length,
                pages: pagesVisited.length,
                total: merged.length,
              });
              if (people.length > 0) {
                console.log(
                  `  [website] ${company.name}: +${people.length} (total ${merged.length}, ${pagesVisited.length} pages)`,
                );
              } else {
                console.log(
                  `  [website] ${company.name}: 0 people (${pagesVisited.length} pages)`,
                );
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              writer.log({
                ts: new Date().toISOString(),
                type: "people_website_fail",
                company: company.name,
                message,
              });
            }
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writer.log({
          ts: new Date().toISOString(),
          type: "website_session_fail",
          message,
        });
        console.warn(`Website people session failed: ${message}`);
      }
    } else {
      console.log("  [website] No companies with websiteUrl — skipping web pass");
    }
  }

  // --- 2. Web search → LinkedIn /in/ SERP (ALWAYS sequential; one reused page) ---
  if (webSearch) {
    const needWebSearch = companies.filter(
      (c) => needsMore(byCompany.get(c.id) ?? [], maxPeople) > 0,
    );
    if (needWebSearch.length > 0) {
      try {
        await withEphemeralBrowser(async (browser) => {
          // Single context+page for all SERP queries (less fingerprint churn)
          await withEphemeralContextPage(browser, async (page) => {
            for (const company of needWebSearch) {
              if (isWebSearchSoftStopped()) {
                writer.log({
                  ts: new Date().toISOString(),
                  type: "people_web_search_soft_stop",
                  company: company.name,
                  reason: "captcha_or_skip",
                });
                console.warn(
                  "  [web-search] Soft-stopped (CAPTCHA / LEAD_SKIP_WEB_SEARCH) — remaining companies use LinkedIn/website only",
                );
                break;
              }
              const need = needsMore(byCompany.get(company.id) ?? [], maxPeople);
              if (need <= 0) continue;
              try {
                const result = await discoverPeopleFromWebSearch(
                  page,
                  company,
                  need,
                );
                if (result.people.length > 0) {
                  const merged = mergePeople(
                    byCompany.get(company.id) ?? [],
                    result.people,
                    maxPeople,
                  );
                  byCompany.set(company.id, merged);
                  console.log(
                    `  [web-search] ${company.name}: +${result.people.length} (total ${merged.length})`,
                  );
                }
                writer.log({
                  ts: new Date().toISOString(),
                  type: "people_web_search",
                  company: company.name,
                  count: result.people.length,
                  searches: result.searchesUsed,
                  query: result.query,
                  blocked: result.blocked,
                  reason: result.reason,
                  total: (byCompany.get(company.id) ?? []).length,
                });
                if (result.blocked) {
                  console.warn(
                    `  [web-search] ${company.name}: SERP challenge/blocked (${result.reason ?? ""})`,
                  );
                }
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                writer.log({
                  ts: new Date().toISOString(),
                  type: "people_web_search_fail",
                  company: company.name,
                  message,
                });
              }
            }
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writer.log({
          ts: new Date().toISOString(),
          type: "web_search_session_fail",
          message,
        });
        console.warn(`Web-search people session failed: ${message}`);
      }
    }
  }

  const stillNeedLinkedIn = companies.filter(
    (c) => needsMore(byCompany.get(c.id) ?? [], maxPeople) > 0,
  );
  const wantLinkedIn =
    (liCompany || liSearch) && stillNeedLinkedIn.length > 0;

  // --- 3+4. LinkedIn filtered company employees, then optional global search (SEQUENTIAL) ---
  if (wantLinkedIn) {
    if (!hasLinkedInAuth()) {
      writer.log({
        ts: new Date().toISOString(),
        type: "linkedin_skipped",
        message: "Missing LinkedIn session; website/web-search results kept.",
      });
      console.warn(
        "Missing LinkedIn session for people fallback. Run `npm run auth:linkedin`. " +
          "Keeping website/web-search results only.",
      );
    } else {
      try {
        await withLinkedInPage(
          async (page) => {
            for (const company of stillNeedLinkedIn) {
              let found = byCompany.get(company.id) ?? [];
              try {
                // 3. Filtered company employees (keywords + title gate)
                if (liCompany && company.linkedinUrl && needsMore(found, maxPeople) > 0) {
                  const fromCo = await discoverPeopleFromLinkedInCompany(
                    page,
                    company,
                    needsMore(found, maxPeople),
                    delayMs,
                  );
                  found = mergePeople(found, fromCo, maxPeople);
                  byCompany.set(company.id, found);
                  writer.log({
                    ts: new Date().toISOString(),
                    type: "people_linkedin_company",
                    company: company.name,
                    count: fromCo.length,
                    total: found.length,
                  });
                  if (fromCo.length > 0) {
                    console.log(
                      `  [li-company] ${company.name}: +${fromCo.length} (total ${found.length})`,
                    );
                  } else {
                    console.log(
                      `  [li-company] ${company.name}: 0 (company People local search)`,
                    );
                  }
                }

                // 4. Global people search — OFF by default (LEAD_PEOPLE_LINKEDIN_SEARCH)
                if (liSearch && needsMore(found, maxPeople) > 0) {
                  if (remainingCap("search") <= 0) {
                    writer.log({
                      ts: new Date().toISOString(),
                      type: "people_linkedin_search_skipped",
                      company: company.name,
                      reason: "search_cap",
                    });
                  } else {
                    const fromSearch = await discoverPeopleFromLinkedInSearch(
                      page,
                      company,
                      needsMore(found, maxPeople),
                      delayMs,
                    );
                    found = mergePeople(found, fromSearch, maxPeople);
                    byCompany.set(company.id, found);
                    writer.log({
                      ts: new Date().toISOString(),
                      type: "people_linkedin_search",
                      company: company.name,
                      count: fromSearch.length,
                      total: found.length,
                    });
                    if (fromSearch.length > 0) {
                      console.log(
                        `  [li-search] ${company.name}: +${fromSearch.length} (total ${found.length})`,
                      );
                    }
                  }
                }

                if (found.length === 0) {
                  writer.log({
                    ts: new Date().toISOString(),
                    type: "no_people",
                    company: company.name,
                  });
                }

                await humanDelay("between_companies", {
                  minMs: Math.min(delayMs, 1500),
                });
              } catch (err) {
                if (err instanceof SafetyLimitError) {
                  writer.log({
                    ts: new Date().toISOString(),
                    type: "safety_limit",
                    message: err.message,
                    company: company.name,
                    action: err.action,
                  });
                  console.warn(err.message);
                  // Search/profile soft caps: continue other companies' filtered
                  // company pass. Runtime / hard exhaustion → stop LinkedIn phase.
                  if (err.action === "job_runtime") return;
                  if (
                    err.action === "page_view" ||
                    err.action === "profile_view"
                  ) {
                    return;
                  }
                  // search cap: skip search for rest; still try company employees
                  continue;
                }
                const message = err instanceof Error ? err.message : String(err);
                writer.log({
                  ts: new Date().toISOString(),
                  type: "people_fail",
                  company: company.name,
                  message,
                });
                if (/login|checkpoint|auth|restriction/i.test(message)) throw err;
              }
            }
          },
          { jobId: "lead-find-decision-makers" },
        );
      } catch (err) {
        if (err instanceof SafetyLimitError) {
          writer.log({
            ts: new Date().toISOString(),
            type: "safety_limit",
            message: err.message,
          });
          console.warn(err.message);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          if (/login|checkpoint|Not authenticated|restriction/i.test(message)) {
            throw err;
          }
          writer.log({
            ts: new Date().toISOString(),
            type: "session_fail",
            message,
          });
          console.warn(`LinkedIn people session failed: ${message}`);
        }
      }
    }
  }

  // Seeds only when explicitly allowed and still empty
  const people: PersonRecord[] = [];
  for (const company of companies) {
    const found = byCompany.get(company.id) ?? [];
    if (found.length > 0) {
      people.push(...toPersonRecords(company, found, now));
      continue;
    }
    if (seedsAllowed) {
      const seeds = seedPeople(company, maxPeople);
      people.push(...seeds);
      writer.log({
        ts: new Date().toISOString(),
        type: "seed_people",
        company: company.name,
        count: seeds.length,
      });
    } else {
      console.warn(
        `  No people for ${company.name} — skipping (LEAD_ALLOW_SEEDS=false)`,
      );
    }
  }

  writeJson(artifactPath(runDir, ARTIFACTS.people), people);
  ensureRunMeta(runDir, runId, config, "lead-find-decision-makers");
  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    count: people.length,
  });
  console.log(`Wrote ${people.length} people → data/leads/${runId}/${ARTIFACTS.people}`);
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (people.length === 0 && !seedsAllowed) {
    return {
      exitCode: 0,
      softSuccess: true,
      message:
        "No decision makers found (LEAD_ALLOW_SEEDS=false — no fake people).",
    };
  }
  return { exitCode: 0, message: `Found ${people.length} people` };
}
