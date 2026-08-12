/**
 * Company genuineness + ICP gate for Lanatus (IT consulting / custom software /
 * automation / cloud). Used by discover (post-scrape), enrich (post-web), and qualify.
 */

import { envInt, envList, DEFAULT_LEAD_INDUSTRIES, DEFAULT_LEAD_KEYWORDS } from "./env.js";
import { normalizeCompanyName, normalizeUrl } from "./io.js";
import type { CompanyRecord } from "./types.js";

export type GenuineCheck = {
  ok: boolean;
  reason?: string;
  cleanedName: string;
};

export type IcpScoreResult = {
  score: number;
  signals: string[];
  penalties: string[];
};

export type LeadGateResult = {
  pass: boolean;
  score: number;
  reasons: string[];
  signals: string[];
  penalties: string[];
};

/** Re-export defaults for callers that import from company-quality. */
export { DEFAULT_LEAD_KEYWORDS, DEFAULT_LEAD_INDUSTRIES };

const UI_CHROME = [
  /^page\s+by\b/i,
  /^pages?\s+\d+/i,
  /^follow\b/i,
  /^message\b/i,
  /^connect\b/i,
  /^see\s+all\b/i,
  /^show\s+more\b/i,
  /^next\b/i,
  /^previous\b/i,
  /^skip\s+to\b/i,
  /^linkedin\b/i,
  /^search\b/i,
  /^home\b/i,
  /^notifications?\b/i,
  /^messaging\b/i,
  /^jobs?\b/i,
  /^people\s+also\b/i,
  /^similar\s+(pages|companies)\b/i,
];

const LOCATION_ONLY =
  /^(united states|usa|u\.s\.a?\.?|canada|uk|united kingdom|india|australia|germany|france|europe|north america|remote|worldwide|global)$/i;

/** Pure consumer / unlikely IT-buyers when no tech signal is present. */
const WEAK_ICP_INDUSTRIES = [
  "apparel",
  "fashion",
  "cosmetics",
  "beauty",
  "restaurants",
  "food & beverages",
  "food and beverage",
  "consumer goods",
  "tobacco",
  "gambling",
  "casinos",
  "sports teams",
  "performing arts",
  "museums",
  "religious",
];

/** Peer IT shops (competitors) — usually not Lanatus buyers. */
const PEER_IT_INDUSTRIES = [
  "it services and it consulting",
  "information technology & services",
  "information technology and services",
  "software development",
  "computer software",
  "it system custom software development",
  "outsourcing/offshoring",
];

const PARKED_DOMAIN_MARKERS = [
  "domain for sale",
  "buy this domain",
  "parked domain",
  "this domain is for sale",
  "godaddy",
  "sedo.com",
  "hugedomains",
  "dan.com",
  "coming soon",
  "website is under construction",
  "default web page",
  "apache2 ubuntu default",
];

const IT_BUYING_SIGNALS = [
  "digital transformation",
  "modernization",
  "legacy",
  "cloud migration",
  "erp",
  "crm",
  "automation",
  "rpa",
  "devops",
  "custom software",
  "software development",
  "it consulting",
  "systems integration",
  "saas",
  "api",
  "data platform",
  "we're hiring",
  "we are hiring",
  "engineering",
  "software engineer",
  "technology",
  "digital",
  "platform",
];

const MID_MARKET_SIZE =
  /\b(5[1-9]|[6-9]\d|\d{3,})\s*[-–]?\s*(\d+)?\s*(employees?|people)?\b/i;

const LINKEDIN_INDUSTRY_CUT =
  /\b(?:IT Services and IT Consulting|Information Technology(?:\s*&\s*|\s+and\s+)Services|Software Development|Computer Software|Non-profit Organization Management|Education Administration Programs|Management Consulting|Business Consulting|Financial Services|Hospital & Health Care|Hospital and Health Care|Higher Education|Retail|Logistics(?:\s+and\s+Supply\s+Chain)?|Manufacturing|Telecommunications|Staffing and Recruiting|Human Resources|Marketing(?:\s+and\s+Advertising)?|Internet|Computer Networking|Semiconductors|Biotechnology|Pharmaceuticals|Insurance|Construction|Oil\s*&\s*Energy|Real Estate|Consumer Goods|Apparel\s*&\s*Fashion|Food\s*&\s*Beverages|Restaurants|Entertainment|Media Production|Broadcast Media|Publishing|Legal Services|Accounting|Banking|Investment Banking|Venture Capital(?:\s*&\s*Private Equity)?|Government Administration|Defense\s*&\s*Space|Aviation\s*&\s*Aerospace|Automotive|Machinery|Electrical\/Electronic Manufacturing|Industrial Automation|Research|Professional Training(?:\s*&\s*Coaching)?|Design|Graphic Design|Animation|Computer Games|Online Media|E-Learning|Environmental Services|Facilities Services|Outsourcing\/Offshoring|Translation and Localization)\b/i;

const CITY_STATE_CUT =
  /\b(?:United States|USA|UK|United Kingdom|Canada|India|Australia|Germany|France|Singapore|Dubai|UAE|Netherlands|Ireland|Poland|Czech(?:\s+Republic)?|South Africa|Brazil|Mexico|Japan|China|Hong Kong|New Zealand)\b.*$/i;

const CITY_COMMA_CUT =
  /\b[A-Z][a-zA-Z .'-]+,\s*[A-Z][a-zA-Z .'-]{2,}(?:\s+Follow\b.*)?$/;

/**
 * Detect doubled accessible labels with or without a space:
 * "Acme Acme …", "AcmeAcme…", "Cloud MatricCloud Matric…"
 */
function undoubleGluedName(name: string): string {
  // Spaced exact repeat at start: "Foo Bar Foo Bar rest"
  const spaced = name.match(/^(.{3,60}?)\s+\1\b/i);
  if (spaced) return spaced[1].trim();

  // Glued exact repeat: try decreasing prefix lengths
  const max = Math.min(Math.floor(name.length / 2), 60);
  for (let len = max; len >= 3; len--) {
    const a = name.slice(0, len);
    const b = name.slice(len, len * 2);
    if (a.toLowerCase() === b.toLowerCase()) {
      // Prefer splits that don't end mid-word awkwardly unless camelCase boundary
      const next = name[len * 2] ?? "";
      const boundaryOk =
        !next ||
        /[\s·•|,]/.test(next) ||
        (/[a-z]/.test(a[a.length - 1]!) && /[A-Z]/.test(next)) ||
        /[A-Z]/.test(b[0]!);
      if (boundaryOk || len === max) return a.trim();
    }
  }

  // CamelCase glue after repeat: "CloudMatricCloudMatricIT…" already handled;
  // also "NameNameIndustry" where second copy starts with capital mid-string
  const camel = name.match(/^([A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,5})(?=\1)/);
  if (camel) return camel[1].trim();

  return name;
}

/**
 * Strip LinkedIn card chrome: Follow/Message CTAs, follower/employee noise,
 * duplicated accessible names, trailing industry mashups.
 */
export function cleanCompanyName(raw: string): string {
  let name = (raw || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) return "";

  // Deduplicate exact doubled accessible labels ("AcmeAcme" / "Acme Acme")
  const half = Math.floor(name.length / 2);
  if (half > 3) {
    const a = name.slice(0, half).trim();
    const b = name.slice(half).trim();
    if (a.toLowerCase() === b.toLowerCase()) name = a;
  }

  name = undoubleGluedName(name);

  name = name
    .replace(/\bFollow\b.*$/i, "")
    .replace(/\bMessage\b.*$/i, "")
    .replace(/\bConnect\b.*$/i, "")
    .replace(/\bInvite\b.*$/i, "")
    .replace(/\b\d[\d,]*(?:\+)?\s*(?:followers?|employees?|connections?)\b.*$/i, "")
    .replace(/\b(?:followers?|employees?)\b.*$/i, "")
    .replace(/\s*[·•|]\s*.*$/, "") // "Name · Industry" → Name when primary is name
    .replace(/\s{2,}/g, " ")
    .trim();

  // Cut at LinkedIn industry subtitle mashed into the name
  const ind = name.search(LINKEDIN_INDUSTRY_CUT);
  if (ind > 2) name = name.slice(0, ind).trim();

  // Cut city, region / country tails
  const city = name.search(CITY_COMMA_CUT);
  if (city > 2) name = name.slice(0, city).trim();
  name = name.replace(CITY_STATE_CUT, "").trim();

  // "IndustryFollow CompanyName" mashups — if Follow was mid-string
  name = name.replace(/([a-z])Follow\b/gi, "$1 ").replace(/\s+/g, " ").trim();

  // Truncate if leftover CTA fragments
  const ctaIdx = name.search(/\b(Follow|Message|Connect)\b/i);
  if (ctaIdx > 0) name = name.slice(0, ctaIdx).trim();

  // Trailing ellipsis / description crumbs
  name = name.replace(/\s*\.{2,}.*$/, "").replace(/\s+….*$/, "").trim();

  return name.slice(0, 120);
}

/** Infer LinkedIn industry label mashed into card description text. */
export function inferIndustryFromText(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(LINKEDIN_INDUSTRY_CUT);
  if (!m?.[0]) return undefined;
  return m[0].slice(0, 80);
}

/** Title-case a LinkedIn company slug as a fallback display name. */
export function companyNameFromLinkedInSlug(slug: string): string {
  const s = decodeURIComponent(slug || "")
    .replace(/[_+]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s || /^\d+$/.test(s)) return "";
  return s
    .split("-")
    .filter(Boolean)
    .map((w) => {
      if (/^(it|ai|ui|ux|rpa|erp|crm|saas|iot|usa|uk)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ")
    .slice(0, 120);
}

/** True when cleaned name still looks like LinkedIn card mashup. */
export function looksLikeMashedCompanyName(name: string): boolean {
  if (!name) return true;
  if (name.length > 70) return true;
  if (/\bFollow\b|\bMessage\b|\bConnect\b/i.test(name)) return true;
  if (LINKEDIN_INDUSTRY_CUT.test(name)) return true;
  if (/,\s*[A-Z][a-z]+/.test(name) && name.length > 40) return true;
  // Doubled phrase still present
  if (/^(.{3,40})\s+\1\b/i.test(name)) return true;
  return false;
}

export function isGenuineCompanyName(name: string): GenuineCheck {
  const cleanedName = cleanCompanyName(name);
  if (!cleanedName || cleanedName.length < 2) {
    return { ok: false, reason: "empty_or_too_short", cleanedName };
  }
  if (cleanedName.length < 3 && !/[a-z]/i.test(cleanedName)) {
    return { ok: false, reason: "empty_or_too_short", cleanedName };
  }
  for (const re of UI_CHROME) {
    if (re.test(cleanedName)) {
      return { ok: false, reason: "ui_chrome", cleanedName };
    }
  }
  if (LOCATION_ONLY.test(cleanedName)) {
    return { ok: false, reason: "location_only", cleanedName };
  }
  if (/^page\s+by\b/i.test(cleanedName) || /\bpage\s+by\b/i.test(cleanedName)) {
    return { ok: false, reason: "page_by_junk", cleanedName };
  }
  // Mostly punctuation / numbers
  const letters = cleanedName.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 2) {
    return { ok: false, reason: "not_a_name", cleanedName };
  }
  // Pagination / result chrome
  if (/^\d+\s*(results?|companies|pages?)\b/i.test(cleanedName)) {
    return { ok: false, reason: "pagination_chrome", cleanedName };
  }
  if (/^(companies|people|posts|jobs|groups|events|products)\b/i.test(cleanedName)) {
    return { ok: false, reason: "search_nav_chrome", cleanedName };
  }
  if (looksLikeMashedCompanyName(cleanedName)) {
    return { ok: false, reason: "mashed_card_text", cleanedName };
  }
  return { ok: true, cleanedName };
}

/** Canonical https://www.linkedin.com/company/<slug>/ or undefined if malformed. */
export function normalizeLinkedInCompanyUrl(
  url: string | undefined,
): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const u = new URL(url.trim());
    if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ""))) {
      return undefined;
    }
    const m = u.pathname.match(/\/company\/([^/?#]+)/i);
    if (!m) return undefined;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    if (!slug || /^(school|showcase|admin)$/i.test(slug)) return undefined;
    if (/^\d+$/.test(slug) && /\/(admin|posts|jobs)/i.test(u.pathname)) {
      return undefined;
    }
    // Reject path junk like "company/acme/posts"
    const rest = u.pathname.replace(/\/company\/[^/]+\/?/i, "").replace(/\/+$/, "");
    if (rest && !/^about$/i.test(rest)) {
      // Allow bare company slug only (or /about)
      if (/posts|jobs|admin|people|life|insights/i.test(rest)) return undefined;
    }
    return `https://www.linkedin.com/company/${slug}/`;
  } catch {
    return undefined;
  }
}

export function isValidLinkedInCompanyUrl(url: string | undefined): boolean {
  return Boolean(normalizeLinkedInCompanyUrl(url));
}

function haystack(company: CompanyRecord): string {
  return [
    company.name,
    company.industry,
    company.description,
    company.about,
    company.tagline,
    company.metaDescription,
    company.pageTitle,
    company.employeeCount,
    ...(company.specialties ?? []),
    ...(company.techKeywords ?? []),
    ...(company.servicesHints ?? []),
    ...(company.techSignals?.stackKeywords ?? []),
    ...(company.techSignals?.vendorKeywords ?? []),
    ...(company.techSignals?.buyingHints ?? []),
    ...(company.notes ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isParkedOrEmptyWeb(company: CompanyRecord): boolean {
  const blob = [
    company.pageTitle,
    company.metaDescription,
    company.about,
    company.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!blob && company.notes?.some((n) => /website_fail|web_search_no_result/i.test(n))) {
    return true;
  }
  return PARKED_DOMAIN_MARKERS.some((m) => blob.includes(m));
}

function hasItSignal(text: string, keywords: string[]): boolean {
  for (const k of keywords) {
    if (k && text.includes(k.toLowerCase())) return true;
  }
  for (const s of IT_BUYING_SIGNALS) {
    if (text.includes(s)) return true;
  }
  return false;
}

/**
 * Score 0–100 for Lanatus ICP fit (company-level, before person scoring).
 */
export function scoreCompanyIcp(
  company: CompanyRecord,
  options?: {
    keywords?: string[];
    industries?: string[];
  },
): IcpScoreResult {
  const keywords =
    options?.keywords ??
    envList("LEAD_KEYWORDS", DEFAULT_LEAD_KEYWORDS);
  const industries =
    options?.industries ??
    envList("LEAD_INDUSTRIES", DEFAULT_LEAD_INDUSTRIES);

  const text = haystack(company);
  const signals: string[] = [];
  const penalties: string[] = [];
  let score = 25; // modest base for a real company

  // Keyword overlap
  let kwHits = 0;
  for (const k of keywords) {
    const term = k.trim().toLowerCase();
    if (term && text.includes(term)) {
      kwHits += 1;
      signals.push(`keyword:${k.trim()}`);
    }
  }
  if (kwHits) score += Math.min(30, kwHits * 6);

  // Industry match
  const industryBlob = `${company.industry ?? ""} ${text}`.toLowerCase();
  let indHits = 0;
  for (const ind of industries) {
    const term = ind.trim().toLowerCase();
    if (term && industryBlob.includes(term)) {
      indHits += 1;
      signals.push(`industry:${ind.trim()}`);
    }
  }
  if (indHits) score += Math.min(15, indHits * 8);

  // IT / buying language
  let buyHits = 0;
  for (const s of IT_BUYING_SIGNALS) {
    if (text.includes(s)) {
      buyHits += 1;
      if (buyHits <= 5) signals.push(`buying:${s}`);
    }
  }
  if (buyHits) score += Math.min(20, buyHits * 3);

  // Mid-market+ size hint
  const sizeText = `${company.employeeCount ?? ""} ${company.description ?? ""}`;
  if (MID_MARKET_SIZE.test(sizeText) || /\b(51-200|201-500|501-1000|1001-5000|5001-10000|10001\+)\b/i.test(sizeText)) {
    score += 10;
    signals.push("mid_market_size");
  }

  // Hiring / careers
  if (
    company.careersUrl ||
    company.techSignals?.careersMentionsHiring ||
    /\bhiring\b|\bcareers?\b|\bopen roles?\b/i.test(text)
  ) {
    score += 8;
    signals.push("hiring_or_careers");
  }

  // Website quality
  if (company.websiteUrl) {
    score += 8;
    signals.push("has_website");
    if (company.verification?.websiteOk || company.notes?.includes("website_ok")) {
      score += 4;
      signals.push("website_ok");
    }
  } else {
    score -= 15;
    penalties.push("no_website");
  }

  if (isParkedOrEmptyWeb(company)) {
    score -= 25;
    penalties.push("parked_or_empty_web");
  }

  // Tech keywords from enrich
  if (company.techKeywords?.length) {
    score += Math.min(12, company.techKeywords.length * 2);
    signals.push(`tech_kw:${company.techKeywords.length}`);
  }
  if (company.servicesHints?.length) {
    score += Math.min(8, company.servicesHints.length * 2);
    signals.push("services_hints");
  }

  // Weak ICP industries without IT signal
  const weak = WEAK_ICP_INDUSTRIES.some((w) => industryBlob.includes(w));
  if (weak && !hasItSignal(text, keywords)) {
    score -= 30;
    penalties.push("weak_icp_industry_no_it");
  }

  // Peer IT consultancies / software shops (competitors, not buyers)
  const isPeerIt = PEER_IT_INDUSTRIES.some((w) => industryBlob.includes(w));
  if (isPeerIt) {
    const buyerIndustry = industries.some((ind) => {
      const term = ind.trim().toLowerCase();
      return (
        term &&
        industryBlob.includes(term) &&
        !PEER_IT_INDUSTRIES.includes(term)
      );
    });
    if (!buyerIndustry) {
      // Soft downrank — still allow strong web-enriched peers through enrich (≥50)
      score -= 15;
      penalties.push("peer_it_consultancy");
    }
  }

  // LinkedIn presence (nice-to-have)
  if (company.linkedinUrl && isValidLinkedInCompanyUrl(company.linkedinUrl)) {
    score += 3;
    signals.push("valid_linkedin");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, signals: [...new Set(signals)], penalties: [...new Set(penalties)] };
}

export function leadMinCompanyScore(): number {
  return envInt("LEAD_MIN_COMPANY_SCORE", 50);
}

/**
 * Hard genuineness checks + ICP score threshold.
 * `stage`: discover is lighter (less web data); enrich/qualify can require website.
 */
export function passesLeadGate(
  company: CompanyRecord,
  minScore?: number,
  options?: {
    keywords?: string[];
    industries?: string[];
    /** When true (post-enrich), require a real website or fail. */
    requireWebsite?: boolean;
  },
): LeadGateResult {
  const threshold = minScore ?? leadMinCompanyScore();
  const genuine = isGenuineCompanyName(company.name);
  const reasons: string[] = [];

  if (!genuine.ok) {
    return {
      pass: false,
      score: 0,
      reasons: [genuine.reason ?? "not_genuine"],
      signals: [],
      penalties: [genuine.reason ?? "not_genuine"],
    };
  }

  if (company.linkedinUrl && !isValidLinkedInCompanyUrl(company.linkedinUrl)) {
    reasons.push("malformed_linkedin_url");
  }

  const icp = scoreCompanyIcp(company, options);
  reasons.push(...icp.penalties);

  if (options?.requireWebsite && !company.websiteUrl) {
    reasons.push("require_website");
    return {
      pass: false,
      score: Math.min(icp.score, threshold - 1),
      reasons: [...new Set(reasons)],
      signals: icp.signals,
      penalties: [...new Set([...icp.penalties, "require_website"])],
    };
  }

  if (options?.requireWebsite && isParkedOrEmptyWeb(company)) {
    reasons.push("parked_or_empty_web");
    return {
      pass: false,
      score: Math.min(icp.score, threshold - 1),
      reasons: [...new Set(reasons)],
      signals: icp.signals,
      penalties: [...new Set([...icp.penalties, "parked_or_empty_web"])],
    };
  }

  const pass = icp.score >= threshold && !reasons.includes("malformed_linkedin_url");
  if (!pass && icp.score < threshold) {
    reasons.push(`below_min_score:${icp.score}<${threshold}`);
  }

  return {
    pass,
    score: icp.score,
    reasons: [...new Set(reasons)],
    signals: icp.signals,
    penalties: icp.penalties,
  };
}

/** Apply clean name + normalized LinkedIn URL; returns null if not genuine. */
export function sanitizeScrapedCompany<
  T extends { name: string; linkedinUrl?: string; industry?: string; description?: string },
>(raw: T): (T & { name: string; linkedinUrl?: string }) | null {
  const linkedinUrl = normalizeLinkedInCompanyUrl(raw.linkedinUrl);
  if (raw.linkedinUrl && !linkedinUrl) return null;

  let nameCandidate = raw.name;
  let genuine = isGenuineCompanyName(nameCandidate);

  // Card text often mashes name+industry+location — prefer LinkedIn slug title
  if ((!genuine.ok || looksLikeMashedCompanyName(genuine.cleanedName)) && linkedinUrl) {
    const slug = linkedinUrl.match(/\/company\/([^/]+)/i)?.[1] ?? "";
    const fromSlug = companyNameFromLinkedInSlug(slug);
    if (fromSlug) {
      const slugCheck = isGenuineCompanyName(fromSlug);
      if (slugCheck.ok) {
        genuine = slugCheck;
        nameCandidate = fromSlug;
      }
    }
  }

  if (!genuine.ok) return null;

  let industry = raw.industry?.trim();
  if (!industry) {
    industry = inferIndustryFromText(raw.description) || undefined;
  }
  if (industry) {
    industry = cleanCompanyName(industry)
      .replace(/\bFollow\b.*$/i, "")
      .trim()
      .slice(0, 80);
    if (!industry || UI_CHROME.some((re) => re.test(industry!))) industry = undefined;
    if (industry && looksLikeMashedCompanyName(industry)) industry = undefined;
  }

  return {
    ...raw,
    name: genuine.cleanedName,
    linkedinUrl,
    industry: industry || undefined,
    description: raw.description
      ? (() => {
          let d = raw.description.replace(/\s+/g, " ").trim();
          // Prefer text after Follow CTA when card mash includes chrome
          const afterFollow = d.split(/\bFollow\b/i).pop()?.trim();
          if (afterFollow && afterFollow.length > 40) d = afterFollow;
          d = d.replace(/^[\w&'’.\-\s]{0,80}?(?=IT Services and IT Consulting|Information Technology)/i, "");
          return d.slice(0, 240) || undefined;
        })()
      : undefined,
  };
}

/** Annotate company with icpScore / notes; does not mutate input. */
export function withIcpAnnotation(
  company: CompanyRecord,
  gate: LeadGateResult,
): CompanyRecord {
  const notes = [
    ...(company.notes ?? []),
    `icp_score:${gate.score}`,
    ...(gate.pass ? ["icp_gate:pass"] : [`icp_gate:reject:${gate.reasons.join("|")}`]),
    ...gate.signals.slice(0, 8).map((s) => `icp_signal:${s}`),
  ];
  return {
    ...company,
    name: cleanCompanyName(company.name) || company.name,
    normalizedName: normalizeCompanyName(
      cleanCompanyName(company.name) || company.name,
    ),
    linkedinUrl:
      normalizeLinkedInCompanyUrl(company.linkedinUrl) || company.linkedinUrl,
    websiteUrl: normalizeUrl(company.websiteUrl) || company.websiteUrl,
    notes,
  };
}
