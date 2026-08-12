import "dotenv/config";
import path from "node:path";
import type { Page } from "playwright";
import type { JobRunResult } from "../../lib/job-types.js";
import { createJsonlLogger, jobLogPath, type LogEvent } from "../../lib/logging.js";
import {
  hasLinkedInAuth,
  withEphemeralPage,
  withLinkedInPage,
} from "../../lib/leads/browser.js";
import {
  hasSharedLeadBrowsers,
  withSharedLeadBrowsers,
} from "../../lib/leads/browser-session.js";
import {
  leadMinCompanyScore,
  passesLeadGate,
  withIcpAnnotation,
} from "../../lib/leads/company-quality.js";
import {
  enrichLinkedIn,
  enrichLinkedInWebsite,
  enrichWebFirst,
  envInt,
  isLeadDryRun,
  leadDelayMs,
  leadIndustries,
  leadKeywords,
  maxWebSearches,
  requireWebsite,
  skipWebSearch,
  snapshotConfigFromEnv,
} from "../../lib/leads/env.js";
import {
  SafetyLimitError,
  humanDelay,
} from "../../lib/linkedin-safety.js";
import {
  ARTIFACTS,
  type CompanyRecord,
  type LinkedInHarvestArtifact,
  type PersonRecord,
} from "../../lib/leads/types.js";
import {
  artifactPath,
  ensureRunMeta,
  loadCompanies,
  resolveRunDir,
  slugId,
  writeJson,
} from "../../lib/leads/io.js";
import {
  harvestLinkedInCompany,
  harvestToTechSignals,
  type LinkedInHarvestResult,
} from "../../lib/leads/linkedin-harvest.js";
import {
  extractWebPage,
  officialSiteSearchHint,
  resetWebSearchBudget,
  searchOfficialWebsiteMulti,
} from "../../lib/leads/web.js";

function enrichmentConfidenceFor(
  company: CompanyRecord,
): CompanyRecord["enrichmentConfidence"] {
  if (company.websiteUrl && (company.about || company.metaDescription || company.pageTitle)) {
    return "high";
  }
  if (company.websiteUrl) return "medium";
  return "low";
}

async function enrichFromWeb(
  page: Page,
  company: CompanyRecord,
  delayMs: number,
  log: (e: LogEvent) => void,
): Promise<Partial<CompanyRecord>> {
  let websiteUrl = company.websiteUrl;
  const notes: string[] = [];

  if (!websiteUrl) {
    const search = await searchOfficialWebsiteMulti(page, company.name, {
      hint: company.websiteSearchHint || officialSiteSearchHint(company.name),
      maxQueries: 4,
    });
    log({
      ts: new Date().toISOString(),
      type: "web_search",
      name: company.name,
      engine: search.engine,
      query: search.query,
      found: search.websiteUrl,
      skipped: search.skipped,
      reason: search.reason,
      candidates: search.candidates,
      queriesTried: search.queriesTried,
    });
    if (search.websiteUrl) {
      websiteUrl = search.websiteUrl;
      notes.push("website_from_search");
    } else if (search.skipped) {
      notes.push(`web_search_skipped:${search.reason ?? "cap"}`);
    } else {
      notes.push("web_search_no_result");
    }
    await humanDelay("idle_micro", { minMs: Math.min(delayMs, 800) });
  }

  if (!websiteUrl) {
    return {
      notes,
      enrichmentConfidence: "low",
    };
  }

  const web = await extractWebPage(page, websiteUrl);
  notes.push(web.ok ? "website_ok" : `website_fail:${web.error ?? web.status}`);

  const patch: Partial<CompanyRecord> = {
    websiteUrl,
    pageTitle: web.pageTitle,
    metaDescription: web.metaDescription,
    about: web.aboutBlurb || web.metaDescription,
    description: company.description || web.aboutBlurb || web.metaDescription,
    techKeywords: web.techKeywords,
    careersUrl: web.careersUrl,
    contactUrl: web.contactUrl,
    servicesHints: web.servicesHints,
    location: company.location || web.locationHints[0],
    notes,
  };
  patch.enrichmentConfidence = enrichmentConfidenceFor({
    ...company,
    ...patch,
  });
  return patch;
}

function mergeCompany(
  base: CompanyRecord,
  patch: Partial<CompanyRecord>,
): CompanyRecord {
  const notes = [...(base.notes ?? []), ...(patch.notes ?? [])];
  const techKeywords = [
    ...new Set([...(base.techKeywords ?? []), ...(patch.techKeywords ?? [])]),
  ];
  const servicesHints = [
    ...new Set([...(base.servicesHints ?? []), ...(patch.servicesHints ?? [])]),
  ];
  const enrichmentConfidence =
    patch.enrichmentConfidence ??
    base.enrichmentConfidence ??
    enrichmentConfidenceFor({ ...base, ...patch });
  return {
    ...base,
    ...patch,
    techKeywords: techKeywords.length ? techKeywords : undefined,
    servicesHints: servicesHints.length ? servicesHints : undefined,
    notes: notes.length ? notes : undefined,
    enrichmentConfidence,
  };
}

export async function run(): Promise<JobRunResult> {
  if (!hasSharedLeadBrowsers()) {
    return withSharedLeadBrowsers(() => run(), {
      jobId: "lead-enrich-company",
    });
  }

  const dryRun = isLeadDryRun();
  const max = envInt("LEAD_MAX_COMPANIES", 10);
  const delayMs = leadDelayMs();
  const webFirst = enrichWebFirst();
  const doLinkedIn = enrichLinkedIn();
  const doLinkedInWebsite = enrichLinkedInWebsite();
  const needWebsite = requireWebsite();
  const noWebSearch = skipWebSearch();
  /** Default path: LinkedIn About for website URL, then crawl — no SERP. */
  const linkedInAboutFirst = noWebSearch || !webFirst;
  const config = snapshotConfigFromEnv();
  const { runId, runDir } = resolveRunDir();
  ensureRunMeta(runDir, runId, config);

  const logPath = jobLogPath("lead-enrich-company");
  const writer = createJsonlLogger(logPath);

  // Prefer base when resuming after a wiped empty enriched artifact
  const input = loadCompanies(runDir, "best").slice(0, max);
  if (input.length === 0) {
    // Do not write empty enriched over a failed prior run — leave base intact
    await writer.close();
    return {
      exitCode: 0,
      softSuccess: true,
      message: "No companies to enrich.",
    };
  }

  console.log(
    `\nEnriching ${input.length} companies (run ${runId}, dryRun=${dryRun}, ` +
      `linkedInAboutFirst=${linkedInAboutFirst}, skipWebSearch=${noWebSearch}, ` +
      `webFirst=${webFirst}, linkedIn=${doLinkedIn}, linkedInWebsite=${doLinkedInWebsite}, ` +
      `requireWebsite=${needWebsite}, maxWebSearches=${maxWebSearches()})\n`,
  );

  resetWebSearchBudget();
  let enriched: CompanyRecord[] = input.map((c) => ({ ...c }));

  const runWebEnrichPass = async (label: string) => {
    if (!webFirst && label === "primary") return;
    await withEphemeralPage(async (page) => {
      for (let i = 0; i < enriched.length; i++) {
        const c = enriched[i]!;
        // After LinkedIn-first: only crawl companies that already have a URL
        if (label === "after_linkedin" && !c.websiteUrl) continue;
        // LinkedIn-first primary skip: don't waste a SERP-less pass before About
        if (label === "primary" && linkedInAboutFirst && !c.websiteUrl) continue;
        try {
          const patch = await enrichFromWeb(page, c, delayMs, writer.log);
          enriched[i] = mergeCompany(c, patch);
          writer.log({
            ts: new Date().toISOString(),
            type: "web_enrich",
            pass: label,
            name: c.name,
            websiteUrl: enriched[i]!.websiteUrl,
            title: enriched[i]!.pageTitle,
            confidence: enriched[i]!.enrichmentConfidence,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writer.log({
            ts: new Date().toISOString(),
            type: "web_enrich_fail",
            pass: label,
            name: c.name,
            message,
          });
        }
        if (i < enriched.length - 1) {
          await humanDelay("between_companies", {
            minMs: Math.min(delayMs, 2000),
          });
        }
      }
    });
  };

  // Search-enabled path: try website/search before LinkedIn
  if (!linkedInAboutFirst) {
    await runWebEnrichPass("primary");
  }

  const needsLinkedInSession =
    hasLinkedInAuth() &&
    (doLinkedIn || doLinkedInWebsite) &&
    enriched.some((c) => Boolean(c.linkedinUrl));

  const maxPeople = envInt("LEAD_MAX_PEOPLE_PER_COMPANY", 3);
  const harvests: LinkedInHarvestResult[] = [];

  // --- Single LinkedIn session: About → People (local) → Posts per company ---
  if (needsLinkedInSession) {
    try {
      await withLinkedInPage(
        async (page) => {
          for (let i = 0; i < enriched.length; i++) {
            const company = enriched[i]!;
            if (!company.linkedinUrl) continue;
            try {
              const harvest = await harvestLinkedInCompany(page, company, {
                maxPeople,
                delayMs,
              });
              harvests.push(harvest);

              const postTech = harvestToTechSignals(harvest);
              const patch: Partial<CompanyRecord> = {
                about: company.about || harvest.about,
                websiteUrl: company.websiteUrl || harvest.websiteUrl,
                industry: company.industry || harvest.industry,
                employeeCount: harvest.employeeCount || company.employeeCount,
                location: company.location || harvest.location,
                tagline: harvest.tagline || company.tagline,
                description:
                  company.description || harvest.about || harvest.tagline,
                techKeywords: [
                  ...new Set([
                    ...(company.techKeywords ?? []),
                    ...harvest.postKeywords,
                  ]),
                ],
                techSignals: postTech
                  ? {
                      ...postTech,
                      fromLinkedInPosts: true,
                      stackKeywords: [
                        ...new Set([
                          ...(company.techSignals?.stackKeywords ?? []),
                          ...postTech.stackKeywords,
                        ]),
                      ],
                      buyingHints: [
                        ...new Set([
                          ...(company.techSignals?.buyingHints ?? []),
                          ...postTech.buyingHints,
                        ]),
                      ],
                      rawSnippets: [
                        ...(company.techSignals?.rawSnippets ?? []),
                        ...postTech.rawSnippets,
                      ].slice(0, 8),
                    }
                  : company.techSignals,
                notes: [
                  "linkedin_session_harvest",
                  ...harvest.notes,
                  ...(harvest.websiteUrl ? ["website_from_linkedin_about"] : []),
                ],
              };
              patch.enrichmentConfidence = enrichmentConfidenceFor({
                ...company,
                ...patch,
              });
              enriched[i] = mergeCompany(company, patch);

              writer.log({
                ts: new Date().toISOString(),
                type: "linkedin_harvest",
                name: company.name,
                websiteUrl: enriched[i]!.websiteUrl,
                people: harvest.people.length,
                posts: harvest.postSnippets.length,
                keywords: harvest.postKeywords,
                confidence: enriched[i]!.enrichmentConfidence,
              });
              console.log(
                `  [linkedin] ${company.name}: website=${enriched[i]!.websiteUrl ?? "—"} ` +
                  `people=${harvest.people.length} posts=${harvest.postSnippets.length}`,
              );
              await humanDelay("between_companies", {
                minMs: Math.min(delayMs, 1500),
              });
            } catch (err) {
              if (err instanceof SafetyLimitError) {
                writer.log({
                  ts: new Date().toISOString(),
                  type: "safety_limit",
                  message: err.message,
                  name: company.name,
                });
                console.warn(err.message);
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              writer.log({
                ts: new Date().toISOString(),
                type: "linkedin_harvest_fail",
                name: company.name,
                message,
              });
              if (/login|checkpoint|auth|restriction/i.test(message)) throw err;
            }
          }
        },
        { jobId: "lead-enrich-company" },
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
        writer.log({
          ts: new Date().toISOString(),
          type: "linkedin_session_fail",
          message,
        });
        if (/login|checkpoint|Not authenticated|restriction/i.test(message)) {
          throw err;
        }
      }
    }

    // Persist harvest for people / tech-signals jobs
    if (harvests.length > 0) {
      const artifact: LinkedInHarvestArtifact = {
        harvestedAt: new Date().toISOString(),
        companies: harvests.map((h) => ({
          companyId: h.companyId,
          companyName: h.companyName,
          linkedinUrl: h.linkedinUrl,
          websiteUrl: h.websiteUrl,
          about: h.about,
          industry: h.industry,
          employeeCount: h.employeeCount,
          location: h.location,
          tagline: h.tagline,
          people: h.people.map((p) => ({
            name: p.name,
            title: p.title,
            linkedinUrl: p.linkedinUrl,
            source: p.source,
            rankScore: p.rankScore,
          })),
          postSnippets: h.postSnippets,
          postKeywords: h.postKeywords,
          buyingHints: h.buyingHints,
          careersMentionsHiring: h.careersMentionsHiring,
          notes: h.notes,
        })),
      };
      writeJson(artifactPath(runDir, ARTIFACTS.linkedinHarvest), artifact);

      // Seed people.json early so later jobs can reuse without another LI session
      const now = new Date().toISOString();
      const peopleSeed: PersonRecord[] = [];
      for (const h of harvests) {
        for (const p of h.people) {
          peopleSeed.push({
            id: slugId("pe", `${h.companyId}-${p.name}`),
            companyId: h.companyId,
            companyName: h.companyName,
            name: p.name,
            title: p.title,
            linkedinUrl: p.linkedinUrl,
            source: p.source,
            discoveredAt: now,
          });
        }
      }
      if (peopleSeed.length > 0) {
        writeJson(artifactPath(runDir, ARTIFACTS.people), peopleSeed);
        console.log(
          `  Seeded ${peopleSeed.length} people from LinkedIn harvest → ${ARTIFACTS.people}`,
        );
      }
    }
  } else if ((doLinkedIn || doLinkedInWebsite) && !hasLinkedInAuth()) {
    writer.log({
      ts: new Date().toISOString(),
      type: "linkedin_skipped",
      message: "No LinkedIn session; web enrich only.",
    });
  }

  // Default path: crawl sites after LinkedIn About provided websiteUrl
  if (linkedInAboutFirst) {
    await runWebEnrichPass("after_linkedin");
  }

  // Fetch page intel for websites discovered via LinkedIn (ephemeral browser)
  const needsWebsiteExtract = enriched.filter(
    (c) => c.websiteUrl && !c.pageTitle && !c.metaDescription,
  );
  if (needsWebsiteExtract.length > 0) {
    await withEphemeralPage(async (page) => {
      for (const target of needsWebsiteExtract) {
        const idx = enriched.findIndex((c) => c.id === target.id);
        if (idx < 0) continue;
        const cur = enriched[idx]!;
        try {
          const web = await extractWebPage(page, cur.websiteUrl!);
          enriched[idx] = mergeCompany(cur, {
            pageTitle: web.pageTitle,
            metaDescription: web.metaDescription,
            about: cur.about || web.aboutBlurb || web.metaDescription,
            techKeywords: web.techKeywords,
            careersUrl: web.careersUrl || cur.careersUrl,
            contactUrl: web.contactUrl || cur.contactUrl,
            servicesHints: web.servicesHints,
            notes: [
              web.ok
                ? "website_ok_after_linkedin"
                : `website_fail:${web.error ?? web.status}`,
            ],
            enrichmentConfidence: enrichmentConfidenceFor({
              ...cur,
              pageTitle: web.pageTitle,
              metaDescription: web.metaDescription,
              about: cur.about || web.aboutBlurb,
            }),
          });
          writer.log({
            ts: new Date().toISOString(),
            type: "web_enrich_after_linkedin",
            name: cur.name,
            websiteUrl: cur.websiteUrl,
            ok: web.ok,
          });
        } catch (err) {
          writer.log({
            ts: new Date().toISOString(),
            type: "web_enrich_after_linkedin_fail",
            name: cur.name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        await humanDelay("idle_micro", { minMs: Math.min(delayMs, 1000) });
      }
    });
  }

  // Legacy path: web after LinkedIn when web-first disabled
  if (!webFirst) {
    await withEphemeralPage(async (page) => {
      for (let i = 0; i < enriched.length; i++) {
        const c = enriched[i]!;
        if (!c.websiteUrl) {
          const search = await searchOfficialWebsiteMulti(page, c.name, {
            hint: c.websiteSearchHint || officialSiteSearchHint(c.name),
            maxQueries: 4,
          });
          if (search.websiteUrl) {
            enriched[i] = mergeCompany(c, {
              websiteUrl: search.websiteUrl,
              notes: ["website_from_search"],
            });
          }
        }
        const cur = enriched[i]!;
        if (!cur.websiteUrl) {
          enriched[i] = mergeCompany(cur, {
            enrichmentConfidence: "low",
            notes: ["web_search_no_result"],
          });
          continue;
        }
        const web = await extractWebPage(page, cur.websiteUrl);
        enriched[i] = mergeCompany(cur, {
          pageTitle: web.pageTitle || cur.pageTitle,
          metaDescription: web.metaDescription || cur.metaDescription,
          techKeywords: web.techKeywords,
          careersUrl: web.careersUrl || cur.careersUrl,
          contactUrl: web.contactUrl || cur.contactUrl,
          servicesHints: web.servicesHints,
          about: cur.about || web.aboutBlurb || web.metaDescription,
          notes: [
            web.ok ? "website_ok" : `website_fail:${web.error ?? web.status}`,
          ],
          enrichmentConfidence: enrichmentConfidenceFor({
            ...cur,
            pageTitle: web.pageTitle || cur.pageTitle,
            metaDescription: web.metaDescription || cur.metaDescription,
            about: cur.about || web.aboutBlurb,
          }),
        });
        writer.log({
          ts: new Date().toISOString(),
          type: "web_enrich",
          name: cur.name,
          ok: web.ok,
          title: web.pageTitle,
        });
        await humanDelay("idle_micro", { minMs: Math.min(delayMs, 1200) });
      }
    });
  }

  // Ensure every company has a confidence tag
  enriched = enriched.map((c) =>
    mergeCompany(c, {
      enrichmentConfidence: c.enrichmentConfidence ?? enrichmentConfidenceFor(c),
    }),
  );

  // Post-enrich ICP gate: optionally require website (LEAD_REQUIRE_WEBSITE)
  const minCompanyScore = leadMinCompanyScore();
  const keywords = leadKeywords();
  const industries = leadIndustries();
  const gated: CompanyRecord[] = [];
  let rejected = 0;

  console.log(
    `\nPost-enrich ICP gate (min=${minCompanyScore}, requireWebsite=${needWebsite})…`,
  );
  for (const c of enriched) {
    const gate = passesLeadGate(c, minCompanyScore, {
      keywords,
      industries,
      requireWebsite: needWebsite,
    });
    let annotated = withIcpAnnotation(c, gate);
    const hardReject = gate.reasons.some((r) =>
      /not_genuine|malformed_linkedin|require_website|parked_or_empty_web/i.test(
        r,
      ),
    );
    // Soft-keep: website found or prior ICP signals — don't wipe the list for peer/score alone
    const softKeep =
      !gate.pass &&
      !hardReject &&
      (c.enrichmentConfidence === "high" ||
        c.enrichmentConfidence === "medium" ||
        (c.enrichmentConfidence === "low" &&
          Boolean(c.linkedinUrl && (c.description || c.about))));

    if (!gate.pass && !softKeep) {
      rejected += 1;
      writer.log({
        ts: new Date().toISOString(),
        type: "company_rejected",
        name: c.name,
        score: gate.score,
        reasons: gate.reasons,
        stage: "enrich",
        confidence: c.enrichmentConfidence,
      });
      console.log(
        `  ✗ drop ${c.name} (icp=${gate.score}: ${gate.reasons.join(", ")})`,
      );
      continue;
    }
    if (softKeep) {
      annotated = {
        ...annotated,
        notes: [
          ...(annotated.notes ?? []),
          `icp_soft_keep:${gate.reasons.join("|")}`,
        ],
        enrichmentConfidence: c.enrichmentConfidence ?? "low",
      };
    }
    writer.log({
      ts: new Date().toISOString(),
      type: softKeep ? "company_soft_kept" : "company_accepted",
      name: c.name,
      score: gate.score,
      signals: gate.signals.slice(0, 8),
      stage: "enrich",
      websiteUrl: annotated.websiteUrl,
      confidence: annotated.enrichmentConfidence,
    });
    console.log(
      `  ✓ keep ${annotated.name} (icp=${gate.score}, conf=${annotated.enrichmentConfidence ?? "?"}` +
        `${annotated.websiteUrl ? `, ${annotated.websiteUrl}` : ", no website"}` +
        `${softKeep ? ", soft" : ""})`,
    );
    gated.push(annotated);
  }

  // Never wipe advanced artifacts to empty when we still have gated companies;
  // if gate drops everything, still write [] but base companies.json is preserved.
  writeJson(artifactPath(runDir, ARTIFACTS.companiesEnriched), gated);
  ensureRunMeta(runDir, runId, config, "lead-enrich-company");

  writer.log({
    ts: new Date().toISOString(),
    type: "run_end",
    count: gated.length,
    rejected,
    minCompanyScore,
    webFirst,
    linkedIn: doLinkedIn,
    linkedInWebsite: doLinkedInWebsite,
    requireWebsite: needWebsite,
  });
  console.log(
    `Wrote ${gated.length} enriched (dropped ${rejected}) → data/leads/${runId}/${ARTIFACTS.companiesEnriched}`,
  );
  console.log(`Log → ${path.relative(process.cwd(), logPath)}\n`);
  await writer.close();

  if (gated.length === 0) {
    return {
      exitCode: 0,
      softSuccess: true,
      message: `Enrich kept 0 companies after ICP gate (dropped ${rejected}).`,
    };
  }
  return {
    exitCode: 0,
    message: `Enriched ${gated.length} companies (dropped ${rejected})`,
  };
}
