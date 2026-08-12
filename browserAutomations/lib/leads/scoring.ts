import {
  SERVICE_KEYWORD_HINTS,
  resolveOffers,
  serviceLabel,
  type OfferMap,
} from "./services.js";
import type {
  CompanyRecord,
  PersonRecord,
  QualifiedLead,
  ServiceId,
} from "./types.js";

export type ScoreInput = {
  company: CompanyRecord;
  person?: PersonRecord;
  keywords?: string[];
  industries?: string[];
};

export type ScoreResult = {
  score: number;
  buyingSignals: string[];
  recommendedService: ServiceId;
  recommendedServiceLabel: string;
  rationale: string;
};

function haystack(company: CompanyRecord, person?: PersonRecord): string {
  const parts = [
    company.name,
    company.industry,
    company.description,
    company.about,
    company.tagline,
    company.metaDescription,
    company.pageTitle,
    ...(company.specialties ?? []),
    ...(company.techKeywords ?? []),
    ...(company.techSignals?.stackKeywords ?? []),
    ...(company.techSignals?.vendorKeywords ?? []),
    ...(company.techSignals?.buyingHints ?? []),
    person?.title,
    person?.name,
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function countMatches(text: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const t of terms) {
    const term = t.trim().toLowerCase();
    if (term && text.includes(term)) hits.push(t.trim());
  }
  return hits;
}

function pickService(text: string, offers: OfferMap): ServiceId {
  let best: ServiceId = "it_consulting";
  let bestHits = 0;
  for (const [id, hints] of Object.entries(SERVICE_KEYWORD_HINTS) as [
    ServiceId,
    string[],
  ][]) {
    const hits = countMatches(text, hints).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = id;
    }
  }
  // touch offers so unused map still typechecks when customized
  void offers;
  return best;
}

/**
 * Deterministic keyword/rules scoring (no paid LLM required).
 * Optional future: if OPENAI_API_KEY is set, callers may replace rationale.
 */
export function scoreLead(input: ScoreInput): ScoreResult {
  const offers = resolveOffers();
  const company = input.company;
  const person = input.person;
  const text = haystack(company, person);
  const signals: string[] = [];
  let score = 20; // base interest

  const kw = input.keywords ?? [];
  const kwHits = countMatches(text, kw);
  if (kwHits.length) {
    score += Math.min(25, kwHits.length * 5);
    signals.push(...kwHits.map((k) => `keyword:${k}`));
  }

  const ind = input.industries ?? [];
  const indHits = countMatches(
    `${company.industry ?? ""} ${text}`,
    ind,
  );
  if (indHits.length) {
    score += 10;
    signals.push(...indHits.map((i) => `industry:${i}`));
  }

  if (company.websiteUrl) {
    score += 5;
    signals.push("has_website");
  }
  if (company.linkedinUrl) {
    score += 5;
    signals.push("has_linkedin");
  }

  const tech = company.techSignals;
  if (tech?.careersMentionsHiring) {
    score += 12;
    signals.push("hiring_on_careers");
  }
  if (tech?.stackKeywords?.length) {
    score += Math.min(15, tech.stackKeywords.length * 3);
    signals.push(...tech.stackKeywords.slice(0, 5).map((k) => `stack:${k}`));
  }
  if (tech?.buyingHints?.length) {
    score += Math.min(10, tech.buyingHints.length * 4);
    signals.push(...tech.buyingHints.slice(0, 4));
  }

  const title = (person?.title ?? "").toLowerCase();
  const decisionTitle =
    /\b(ceo|cto|cio|cfo|founder|co-founder|owner|vp|vice president|director|head of|chief)\b/i.test(
      title,
    );
  if (decisionTitle) {
    score += 15;
    signals.push(`decision_maker:${person?.title}`);
  } else if (person) {
    score += 5;
    signals.push("has_contact");
  }

  if (company.verification?.websiteOk) {
    score += 3;
    signals.push("website_verified");
  }
  if (person?.verification?.linkedinOk || company.verification?.linkedinOk) {
    score += 2;
    signals.push("linkedin_url_ok");
  }

  if (company.suppressed || person?.suppressed) {
    score = Math.min(score, 10);
    signals.push("suppressed");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const recommendedService = pickService(text, offers);
  const recommendedServiceLabel = serviceLabel(recommendedService, offers);

  const rationaleParts = [
    `${company.name} scored ${score}/100`,
    signals.length
      ? `signals: ${signals.slice(0, 8).join(", ")}`
      : "limited public signals",
    `recommend ${recommendedServiceLabel}`,
  ];
  if (person) {
    rationaleParts.push(`contact ${person.name}${person.title ? ` (${person.title})` : ""}`);
  }

  // Hook for optional LLM polish later:
  // if (process.env.OPENAI_API_KEY) { /* enrich rationale */ }

  return {
    score,
    buyingSignals: [...new Set(signals)],
    recommendedService,
    recommendedServiceLabel,
    rationale: rationaleParts.join(" — "),
  };
}

export function toQualifiedLead(
  company: CompanyRecord,
  person: PersonRecord | undefined,
  scored: ScoreResult,
): QualifiedLead {
  return {
    id: `lead-${company.id}${person ? `-${person.id}` : ""}`,
    companyId: company.id,
    personId: person?.id,
    companyName: company.name,
    personName: person?.name,
    personTitle: person?.title,
    score: scored.score,
    buyingSignals: scored.buyingSignals,
    recommendedService: scored.recommendedService,
    recommendedServiceLabel: scored.recommendedServiceLabel,
    rationale: scored.rationale,
    company,
    person,
    qualifiedAt: new Date().toISOString(),
  };
}
