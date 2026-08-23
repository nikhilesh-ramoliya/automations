/** Types + artifact names for Naukri job-search / apply pipeline. */

export type NaukriJob = {
  id: string;
  title: string;
  companyName: string;
  location?: string;
  experience?: string;
  salary?: string;
  jobUrl: string;
  postedAgo?: string;
  keywordsMatched: string[];
  roleQuery: string;
  geo: string;
  descriptionSnippet?: string;
  discoveredAt: string;
};

export type NaukriApplyResult = {
  jobId: string;
  title: string;
  companyName: string;
  jobUrl: string;
  /** naukri_apply = applied on site; external = company site; skipped / error */
  action: "naukri_apply" | "external" | "already_applied" | "skip" | "error";
  dryRun: boolean;
  ok: boolean;
  detail?: string;
  appliedAt: string;
};

export type NaukriRunConfigSnapshot = {
  roles: string[];
  geos: string[];
  keywords: string[];
  maxJobs: number;
  dryRun: boolean;
};

export type NaukriRunMeta = {
  runId: string;
  createdAt: string;
  updatedAt: string;
  config: NaukriRunConfigSnapshot;
  stepsCompleted: string[];
};

export const ARTIFACTS = {
  meta: "meta.json",
  jobs: "jobs.json",
  applied: "applied.json",
  exportDir: "export",
} as const;
