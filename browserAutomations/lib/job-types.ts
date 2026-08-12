/** Machine-readable job metadata (`jobs/<id>/job.json`). */

export type JobEnvVar = {
  name: string;
  required: boolean;
  default?: string | boolean | number | null;
  description?: string;
};

export type JobRunConfig = {
  /** When true and no dry-run env is set, apply dryRunEnv=true */
  defaultDryRun?: boolean;
  /** Env var toggled by `--dry-run` / `--no-dry-run` (e.g. INVITE_DRY_RUN) */
  dryRunEnv?: string;
  /** Legacy npm script alias, if any */
  npmScript?: string;
};

export type JobHealConfig = {
  /** Clear message + suggest/trigger auth on login redirect */
  reauthOnLoginRedirect?: boolean;
  /** Kill stuck Chromium for our profile path, retry once */
  retryOnProfileLock?: boolean;
  /** Retry whole job once on selector / label_not_found style failures */
  retryOnSelectorMiss?: boolean;
  /** Treat zero credits / zero batch as soft success (job should already exit 0) */
  softExitOnZeroBatch?: boolean;
  /** Max heal retries for retriable failures (default 1) */
  maxRetries?: number;
  /** npm script to suggest for re-auth (default auth:linkedin) */
  authCommand?: string;
  /** Relative path under project root for persistent profile */
  profilePath?: string;
};

export type JobDefinition = {
  id: string;
  name: string;
  description: string;
  /** Entry relative to the job folder (usually `run.ts`) */
  entry: string;
  tags: string[];
  requiresAuth: boolean;
  /**
   * Exclusive LinkedIn job lock for the whole run.
   * Default: true when `requiresAuth` or tags include `linkedin`.
   * Set false for non-LinkedIn jobs that happen to require other auth.
   */
  linkedinLock?: boolean;
  env: JobEnvVar[];
  run?: JobRunConfig;
  heal?: JobHealConfig;
};

export type JobRunResult = {
  exitCode: number;
  softSuccess?: boolean;
  message?: string;
};

/** Optional contract for job entry modules. */
export type JobModule = {
  run: () => Promise<number | JobRunResult | void>;
};
