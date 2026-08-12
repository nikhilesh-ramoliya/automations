/**
 * Rank invite-modal candidates for Lanatus Systems
 * (software / systems / business-automation).
 */

export type InviteCandidate = {
  name: string;
  headline?: string;
  /** Raw row text if available */
  rowText?: string;
  disabled?: boolean;
};

export type ScoredCandidate = InviteCandidate & {
  score: number;
  /** Short reason snippets for logging (matched keywords / skip cause) */
  reasons: string[];
  skip: boolean;
  skipReason?: string;
};

/** Default keywords tuned for Lanatus buyer / decision-maker signals. */
export const DEFAULT_PRIORITY_KEYWORDS: readonly string[] = [
  "founder",
  "co-founder",
  "ceo",
  "cto",
  "coo",
  "cfo",
  "cio",
  "vp",
  "vice president",
  "director",
  "head of",
  "engineering manager",
  "product manager",
  "product owner",
  "operations",
  "digital transformation",
  "automation",
  "software",
  "saas",
  "it consulting",
  "technology",
  "tech",
  "architect",
  "principal",
  "owner",
  "managing director",
  "general manager",
  "business automation",
  "systems",
  "devops",
  "platform",
  "engineering",
  "product",
  "it",
  "consulting",
  "digital",
  "ai",
  "cloud",
];

const PREMIUM_UPSELL_RE =
  /grow faster with|monthly credits|invite more connections|try premium|premium page|easy to cancel|no hidden fees|auto-invite members/i;

/**
 * Strip LinkedIn Premium upsell copy that sometimes pollutes row text.
 */
export function sanitizeInviteText(text: string): string {
  return text
    .replace(
      /Grow faster with[\s\S]*?(?:No hidden fees\.?|Try Premium Page)/gi,
      " ",
    )
    .replace(/Try Premium Page[\s\S]*?(?:No hidden fees\.?)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePriorityKeywords(envValue?: string): string[] {
  if (!envValue?.trim()) return [...DEFAULT_PRIORITY_KEYWORDS];
  const parts = envValue
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length > 0 ? parts : [...DEFAULT_PRIORITY_KEYWORDS];
}

function isEmptyName(name: string): boolean {
  const n = name.replace(/[^\p{L}\p{N}\s.'’-]/gu, "").trim();
  return n.length < 2;
}

/**
 * Score a single candidate. Higher = more relevant for Lanatus outreach.
 */
export function scoreCandidate(
  candidate: InviteCandidate,
  keywords: readonly string[] = DEFAULT_PRIORITY_KEYWORDS,
): ScoredCandidate {
  const name = sanitizeInviteText(candidate.name || "");
  const headline = sanitizeInviteText(candidate.headline || "");
  const rowText = sanitizeInviteText(
    candidate.rowText || `${name} ${headline}`,
  );
  const haystack = `${name} ${headline} ${rowText}`.toLowerCase();

  const base: InviteCandidate = {
    name,
    headline: headline || undefined,
    rowText: candidate.rowText,
    disabled: candidate.disabled,
  };

  if (candidate.disabled) {
    return {
      ...base,
      score: -100,
      reasons: ["disabled"],
      skip: true,
      skipReason: "disabled_row",
    };
  }

  if (isEmptyName(name)) {
    return {
      ...base,
      score: -100,
      reasons: ["empty_name"],
      skip: true,
      skipReason: "empty_name",
    };
  }

  if (
    PREMIUM_UPSELL_RE.test(candidate.name || "") &&
    !/\p{L}{2,}/u.test(sanitizeInviteText(candidate.name || "").slice(0, 40))
  ) {
    return {
      ...base,
      name,
      score: -100,
      reasons: ["premium_upsell"],
      skip: true,
      skipReason: "premium_upsell",
    };
  }

  // Name still polluted with Premium after sanitize → skip
  if (PREMIUM_UPSELL_RE.test(name) || name.length > 80) {
    return {
      ...base,
      score: -100,
      reasons: ["premium_upsell"],
      skip: true,
      skipReason: "premium_upsell",
    };
  }

  if (/already invited|invited to follow/i.test(haystack)) {
    return {
      ...base,
      score: -50,
      reasons: ["already_invited"],
      skip: true,
      skipReason: "already_invited",
    };
  }

  // Non-person / company-only rows (heuristic)
  if (
    /^(inc\.?|llc|ltd\.?|gmbh|corp\.?|company)$/i.test(name) ||
    /\bpage\b/i.test(name)
  ) {
    return {
      ...base,
      score: -40,
      reasons: ["non_person"],
      skip: true,
      skipReason: "non_person",
    };
  }

  let score = 0;
  const reasons: string[] = [];

  for (const kw of keywords) {
    const needle = kw.toLowerCase().trim();
    if (!needle) continue;
    // Word-boundary match so short tokens like "it" / "ai" don't hit "architect"
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
      "iu",
    );
    if (re.test(haystack)) {
      // Decision-maker titles weigh more
      const weight =
        /^(founder|co-founder|ceo|cto|coo|cfo|cio|vp|vice president|director|head of|owner|managing director)$/i.test(
          needle,
        )
          ? 3
          : /engineering manager|product manager|product owner|digital transformation|automation|saas|software|it consulting/i.test(
                needle,
              )
            ? 2
            : 1;
      score += weight;
      if (reasons.length < 6) reasons.push(needle);
    }
  }

  // Mild boost when headline looks professional (has a title-ish separator)
  if (headline && /[|·•@]/.test(headline)) {
    score += 0.5;
    if (!reasons.includes("has_headline")) reasons.push("has_headline");
  }

  return {
    ...base,
    score,
    reasons: reasons.length > 0 ? reasons : ["no_keyword_match"],
    skip: false,
  };
}

/**
 * Sort by score desc; skip junk. Optionally take top N.
 */
export function rankCandidates(
  candidates: InviteCandidate[],
  keywords: readonly string[] = DEFAULT_PRIORITY_KEYWORDS,
  limit?: number,
): ScoredCandidate[] {
  const scored = candidates.map((c) => scoreCandidate(c, keywords));
  const usable = scored
    .filter((c) => !c.skip)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });

  if (limit === undefined || limit < 0) return usable;
  return usable.slice(0, limit);
}
