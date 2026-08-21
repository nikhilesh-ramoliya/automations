/** Types + artifact names for the referral (job hunt) pipeline. */

export type ReferralPersonKind = "recruiter" | "peer";

export type JobPosting = {
  id: string;
  title: string;
  companyName: string;
  companyLinkedInUrl?: string;
  jobUrl: string;
  location?: string;
  geo: string;
  roleQuery: string;
  descriptionSnippet?: string;
  matchedKeywords: string[];
  discoveredAt: string;
};

export type ReferralPerson = {
  id: string;
  name: string;
  title?: string;
  linkedinUrl: string;
  companyName: string;
  companyLinkedInUrl?: string;
  kind: ReferralPersonKind;
  source: "company_people" | "people_search";
  discoveredAt: string;
};

export type ReferralTarget = {
  id: string;
  personId: string;
  jobId: string;
  personName: string;
  personTitle?: string;
  personLinkedInUrl: string;
  kind: ReferralPersonKind;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  geo: string;
  connectNote: string;
  referralMessage: string;
  draftedAt: string;
};

export type ReferralSendResult = {
  targetId: string;
  personName: string;
  companyName: string;
  jobTitle: string;
  linkedinUrl: string;
  action: "linkedin_connect" | "skip";
  dryRun: boolean;
  ok: boolean;
  detail?: string;
  sentAt: string;
};

export type ReferralFollowupResult = {
  targetId: string;
  personName: string;
  companyName: string;
  jobTitle: string;
  linkedinUrl?: string;
  status: "pending" | "messaged" | "skipped" | "error";
  detail?: string;
  messagePreview?: string;
  dryRun: boolean;
  ok: boolean;
  followedUpAt: string;
};

export type ReferralRunConfigSnapshot = {
  roles: string[];
  geos: string[];
  jdKeywords: string[];
  maxJobs: number;
  maxPeoplePerCompany: number;
  dryRun: boolean;
};

export type ReferralRunMeta = {
  runId: string;
  createdAt: string;
  updatedAt: string;
  config: ReferralRunConfigSnapshot;
  stepsCompleted: string[];
};

export const ARTIFACTS = {
  meta: "meta.json",
  jobs: "jobs.json",
  people: "people.json",
  targets: "targets.json",
  sent: "sent.json",
  followup: "followup.json",
  exportDir: "export",
} as const;
