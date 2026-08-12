/** Shared lead-gen data contract for jobs under `data/leads/<runId>/`. */

export type LeadSource = "linkedin" | "web" | "manual" | "seed";

/** Where a person was found (website-first waterfall). */
export type PersonSource =
  | "website"
  | "web_search"
  | "linkedin_company"
  | "linkedin_search"
  | "seed"
  /** @deprecated prefer linkedin_search / linkedin_company */
  | "linkedin"
  | "web"
  | "manual";

export type RunMeta = {
  runId: string;
  createdAt: string;
  updatedAt: string;
  config: LeadRunConfigSnapshot;
  stepsCompleted: string[];
};

export type LeadRunConfigSnapshot = {
  maxCompanies: number;
  maxPeoplePerCompany: number;
  minScore: number;
  keywords: string[];
  geos: string[];
  industries: string[];
  dryRun: boolean;
  offers: Record<string, string>;
};

export type CompanyRecord = {
  id: string;
  name: string;
  normalizedName: string;
  linkedinUrl?: string;
  websiteUrl?: string;
  /** Hint for web-first enrich (`"{name}" official site` or custom). */
  websiteSearchHint?: string;
  industry?: string;
  location?: string;
  description?: string;
  employeeCount?: string;
  source: LeadSource;
  discoveredAt: string;
  /** Enrichment / later stages */
  about?: string;
  specialties?: string[];
  tagline?: string;
  metaDescription?: string;
  pageTitle?: string;
  techKeywords?: string[];
  careersUrl?: string;
  contactUrl?: string;
  servicesHints?: string[];
  techSignals?: TechSignals;
  verification?: ContactVerification;
  suppressed?: boolean;
  suppressReason?: string;
  /**
   * Enrich quality: high = website extracted; medium = website from LI/search
   * with thin page intel; low = kept on ICP/LinkedIn about without website.
   */
  enrichmentConfidence?: "high" | "medium" | "low";
  notes?: string[];
};

export type TechSignals = {
  checkedAt: string;
  careersMentionsHiring?: boolean;
  stackKeywords: string[];
  vendorKeywords: string[];
  rawSnippets: string[];
  buyingHints: string[];
  /** True when signals came (also) from LinkedIn company posts. */
  fromLinkedInPosts?: boolean;
};

/** One-pass LinkedIn company harvest (About + People + Posts). */
export type LinkedInHarvestArtifact = {
  harvestedAt: string;
  companies: Array<{
    companyId: string;
    companyName: string;
    linkedinUrl?: string;
    websiteUrl?: string;
    about?: string;
    industry?: string;
    employeeCount?: string;
    location?: string;
    tagline?: string;
    people: Array<{
      name: string;
      title?: string;
      linkedinUrl?: string;
      source: PersonSource;
      rankScore?: number;
    }>;
    postSnippets: string[];
    postKeywords: string[];
    buyingHints: string[];
    careersMentionsHiring?: boolean;
    notes: string[];
  }>;
};

export type PersonRecord = {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  title?: string;
  linkedinUrl?: string;
  email?: string;
  location?: string;
  source: PersonSource;
  discoveredAt: string;
  verification?: ContactVerification;
  suppressed?: boolean;
  suppressReason?: string;
};

export type ContactVerification = {
  websiteOk?: boolean;
  linkedinOk?: boolean;
  emailMxOk?: boolean | null;
  notes: string[];
  checkedAt: string;
};

export type QualifiedLead = {
  id: string;
  companyId: string;
  personId?: string;
  companyName: string;
  personName?: string;
  personTitle?: string;
  score: number;
  buyingSignals: string[];
  recommendedService: ServiceId;
  recommendedServiceLabel: string;
  rationale: string;
  company: CompanyRecord;
  person?: PersonRecord;
  qualifiedAt: string;
};

export type OutreachDraft = {
  leadId: string;
  channel: "linkedin" | "email";
  subject?: string;
  body: string;
  personalizedFrom: string[];
  draftedAt: string;
};

export type OutreachSendResult = {
  leadId: string;
  companyName: string;
  personName?: string;
  /** Chosen action for this lead */
  action: "email" | "linkedin_connect" | "skip";
  reason?: string;
  email?: string;
  linkedinUrl?: string;
  dryRun: boolean;
  ok: boolean;
  detail?: string;
  sentAt: string;
};

/** Result of post-accept LinkedIn follow-up messaging (`lead-followup-accepted`). */
export type FollowupResult = {
  leadId: string;
  companyName: string;
  personName?: string;
  linkedinUrl?: string;
  /** pending = still waiting; messaged = typed/sent; skipped = not eligible; error = failure */
  status: "pending" | "messaged" | "skipped" | "error";
  detail?: string;
  messagePreview?: string;
  dryRun: boolean;
  ok: boolean;
  followedUpAt: string;
};

export type LeadWithOutreach = QualifiedLead & {
  outreach: OutreachDraft[];
};

export type ServiceId =
  | "custom_software"
  | "automation_rpa"
  | "cloud_devops"
  | "product_engineering"
  | "it_consulting";

export const ARTIFACTS = {
  meta: "meta.json",
  companies: "companies.json",
  companiesEnriched: "companies.enriched.json",
  companiesTech: "companies.tech.json",
  linkedinHarvest: "linkedin.harvest.json",
  people: "people.json",
  leads: "leads.json",
  leadsOutreach: "leads.outreach.json",
  leadsSent: "leads.sent.json",
  leadsFollowup: "leads.followup.json",
  exportDir: "export",
} as const;
