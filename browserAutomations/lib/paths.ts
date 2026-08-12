import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (`browserAutomations/`). */
export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const JOBS_DIR = path.join(PROJECT_ROOT, "jobs");
export const LOGS_DIR = path.join(PROJECT_ROOT, "logs");
export const AUTH_DIR = path.join(PROJECT_ROOT, "auth");
