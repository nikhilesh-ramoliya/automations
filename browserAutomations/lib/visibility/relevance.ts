/**
 * Relevance scoring for visibility engagement.
 * Like only when on-topic; comment only when score is high.
 */

export type RelevanceResult = {
  score: number;
  reasons: string[];
  /** Primary matched topic label, if any */
  topic?: string;
};

/** Phrases that usually mean low-value engagement (poll chrome, spam). */
const LOW_VALUE = [
  /the author can see how you vote/i,
  /\bshow results\b/i,
  /\bvotes?\s*[•·]/i,
  /\b\d+\s*votes?\b/i,
  /\bfollow\s+me\b/i,
  /\bdm\s+me\s+for\b/i,
  /\b congrats\b.*\bworkiversary\b/i,
  /\bhappy (birthday|anniversary)\b/i,
];

type TopicRule = {
  topic: string;
  weight: number;
  patterns: RegExp[];
};

const TOPIC_RULES: TopicRule[] = [
  {
    topic: "AI",
    weight: 28,
    patterns: [
      /\b(genai|generative ai|llm|large language model|chatgpt|copilot)\b/i,
      /\b(machine learning|deep learning|ml ops|mlops)\b/i,
      /\b(artificial intelligence|gen ?ai)\b/i,
      /\b(ai agent|multi-?agent|prompt(?:ing)?|rag)\b/i,
      /\bai\b/i,
    ],
  },
  {
    topic: "automation",
    weight: 26,
    patterns: [
      /\b(automat(e|ion|ing)|rpa|workflow automation)\b/i,
      /\b(ops|operations)\b.*\b(automat|efficien)/i,
      /\b(process improvement|eliminate manual)\b/i,
    ],
  },
  {
    topic: "IT consulting",
    weight: 24,
    patterns: [
      /\b(it consulting|tech consulting|digital transformation)\b/i,
      /\b(advisory|fractional (cto|cio)|engagement)\b/i,
      /\b(enterprise|delivery|implementation)\b.*\b(consult|transform)/i,
    ],
  },
  {
    topic: "custom software",
    weight: 24,
    patterns: [
      /\b(custom software|bespoke software|build vs buy|build-vs-buy)\b/i,
      /\b(software engineering|product engineering|platform engineering)\b/i,
      /\b(saas|product (build|development)|engineering team)\b/i,
    ],
  },
];

/** Extra quality signals (substance, not just keyword spam). */
const QUALITY_BONUSES: Array<{ re: RegExp; points: number; reason: string }> = [
  {
    re: /\b(lesson|learned|we shipped|case study|what worked|mistake|trade-?off)\b/i,
    points: 12,
    reason: "substance:experience",
  },
  {
    re: /\b(team|client|customer|engineering|architecture|roadmap)\b/i,
    points: 6,
    reason: "substance:context",
  },
  {
    re: /\b(how we|here'?s what|in practice|from (the )?field)\b/i,
    points: 8,
    reason: "substance:narrative",
  },
];

const NOISE_PENALTIES: Array<{ re: RegExp; points: number; reason: string }> = [
  { re: /\bhiring\b.*\b(apply|dm|link in comments)\b/i, points: 15, reason: "noise:job_ad" },
  { re: /\b(giveaway|follow.*(like|comment)|like and share)\b/i, points: 20, reason: "noise:engagement_bait" },
  { re: /\b(crypto|nft|forex|guaranteed returns)\b/i, points: 25, reason: "noise:offtopic_spam" },
];

function keywordBoost(text: string, keywords: string[]): { points: number; hits: string[] } {
  const hits: string[] = [];
  let points = 0;
  const lower = text.toLowerCase();
  for (const k of keywords) {
    const term = k.trim().toLowerCase();
    if (term.length >= 2 && lower.includes(term)) {
      hits.push(k.trim());
      points += Math.min(14, 6 + term.length);
    }
  }
  return { points: Math.min(30, points), hits };
}

/**
 * Score 0–100 for how well a post fits personal-brand topics.
 * Comment threshold should be higher than like threshold.
 */
export function scorePostRelevance(
  text: string,
  keywords: string[] = [],
): RelevanceResult {
  const reasons: string[] = [];
  let score = 8; // tiny base — most posts stay low without signals
  const body = (text || "").trim();
  if (body.length < 40) {
    return { score: 5, reasons: ["too_short"] };
  }

  for (const re of LOW_VALUE) {
    if (re.test(body)) {
      score -= 18;
      reasons.push("low_value:poll_or_chrome");
      break;
    }
  }

  let bestTopic: string | undefined;
  let bestTopicPoints = 0;
  for (const rule of TOPIC_RULES) {
    let hits = 0;
    for (const p of rule.patterns) {
      if (p.test(body)) hits += 1;
    }
    if (hits > 0) {
      const points = Math.min(rule.weight, rule.weight * 0.55 + hits * 8);
      score += points;
      reasons.push(`topic:${rule.topic}×${hits}`);
      if (points > bestTopicPoints) {
        bestTopicPoints = points;
        bestTopic = rule.topic;
      }
    }
  }

  const kw = keywordBoost(body, keywords);
  if (kw.points) {
    score += kw.points;
    for (const h of kw.hits.slice(0, 4)) reasons.push(`keyword:${h}`);
  }

  for (const b of QUALITY_BONUSES) {
    if (b.re.test(body)) {
      score += b.points;
      reasons.push(b.reason);
    }
  }

  for (const n of NOISE_PENALTIES) {
    if (n.re.test(body)) {
      score -= n.points;
      reasons.push(n.reason);
    }
  }

  // Length sweet spot: enough to have a point of view
  if (body.length >= 180 && body.length <= 2200) {
    score += 6;
    reasons.push("length:ok");
  } else if (body.length > 2200) {
    score += 2;
  }

  // Bare poll with almost no commentary stays low even if "AI" appears in options
  if (
    /show results|the author can see how you vote/i.test(body) &&
    body.length < 280
  ) {
    score = Math.min(score, 40);
    reasons.push("cap:thin_poll");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons: [...new Set(reasons)], topic: bestTopic };
}

export function shouldLike(
  relevance: RelevanceResult,
  likeMinScore: number,
): boolean {
  return relevance.score >= likeMinScore;
}

export function shouldComment(
  relevance: RelevanceResult,
  commentMinScore: number,
): boolean {
  return relevance.score >= commentMinScore;
}

/**
 * Lead-fit for Lanatus as a software development / IT consulting company.
 * High score = author/post signals buying intent or ICP (build, hire eng, transform, etc.).
 * Used to gate connection requests — not for casual likes.
 */
export function scoreLeadFitForSoftwareDev(
  text: string,
  extras?: { authorHeadline?: string },
): RelevanceResult {
  const reasons: string[] = [];
  let score = 0;
  const body = `${text || ""}\n${extras?.authorHeadline || ""}`.trim();
  if (body.length < 40) {
    return { score: 0, reasons: ["too_short"] };
  }

  const BUYING: Array<{ re: RegExp; points: number; reason: string }> = [
    {
      re: /\b(hir(e|ing)|we('?re| are) looking for|open roles?|join our (eng|team))\b/i,
      points: 22,
      reason: "lead:hiring",
    },
    {
      re: /\b(build(ing)? (a |our )?(platform|product|app|mvp)|greenfield|rewrite|migration)\b/i,
      points: 20,
      reason: "lead:building_product",
    },
    {
      re: /\b(custom software|bespoke|outsource|nearshore|development partner|eng(ineering)? partner)\b/i,
      points: 24,
      reason: "lead:custom_dev",
    },
    {
      re: /\b(digital transformation|moderni[sz]e|legacy (system|stack)|tech debt)\b/i,
      points: 18,
      reason: "lead:transformation",
    },
    {
      re: /\b(automat(e|ion)|rpa|workflow|ops efficiency|manual process)\b/i,
      points: 16,
      reason: "lead:automation",
    },
    {
      re: /\b(cto|vp engineering|head of eng|engineering manager|founder)\b/i,
      points: 14,
      reason: "lead:decision_maker_title",
    },
    {
      re: /\b(saas|b2b|enterprise software|api platform|cloud migration)\b/i,
      points: 12,
      reason: "lead:saas_enterprise",
    },
    {
      re: /\b(need (a |an )?(team|agency|vendor)|looking for (a )?partner|rfp)\b/i,
      points: 22,
      reason: "lead:seeking_partner",
    },
  ];

  const PENALTY: Array<{ re: RegExp; points: number; reason: string }> = [
    {
      re: /\b(i('?m| am) (a )?software (engineer|developer)|open to work|job seeker)\b/i,
      points: 20,
      reason: "penalty:job_seeker",
    },
    {
      re: /\b(course|bootcamp|certification|follow for tips|like and share)\b/i,
      points: 15,
      reason: "penalty:creator_bait",
    },
    {
      re: /\b(we (are|offer) (an? )?(it services|software development) (company|agency))\b/i,
      points: 18,
      reason: "penalty:peer_agency",
    },
    {
      re: /the author can see how you vote|show results|\b\d+\s*votes?\b/i,
      points: 25,
      reason: "penalty:poll",
    },
  ];

  for (const b of BUYING) {
    if (b.re.test(body)) {
      score += b.points;
      reasons.push(b.reason);
    }
  }
  for (const p of PENALTY) {
    if (p.re.test(body)) {
      score -= p.points;
      reasons.push(p.reason);
    }
  }

  // Base topic relevance helps a bit
  const topic = scorePostRelevance(text);
  if (topic.score >= 70) {
    score += 10;
    reasons.push("topic_strong");
  } else if (topic.score >= 55) {
    score += 5;
    reasons.push("topic_ok");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons: [...new Set(reasons)], topic: topic.topic };
}

/** Connect only when lead-fit is very high (software-dev ICP). */
export function shouldConnect(
  leadFit: RelevanceResult,
  connectMinScore: number,
): boolean {
  return leadFit.score >= connectMinScore;
}
