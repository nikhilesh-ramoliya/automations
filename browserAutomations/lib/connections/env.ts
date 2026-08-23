export type SupabaseConfig = {
  url: string;
  publishableKey: string;
  serviceRoleKey: string;
};

export function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return v === "true" || v === "1";
}

export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

export function isConnectionFollowupDryRun(): boolean {
  if (process.env.DRY_RUN === "true") return true;
  return envBool("CONNECTION_FOLLOWUP_DRY_RUN", true);
}

export function readSupabaseConfig(): {
  url: string;
  publishableKey: string;
  serviceRoleKey?: string;
} | null {
  const url = (
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    ""
  )
    .trim()
    .replace(/\/$/, "");
  const publishableKey = (
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    ""
  ).trim();
  if (!url || !publishableKey) return null;

  const serviceRoleKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  ).trim();

  return {
    url,
    publishableKey,
    serviceRoleKey: serviceRoleKey || undefined,
  };
}

export function requireServiceRoleKey(dryRun: boolean): string | null {
  const cfg = readSupabaseConfig();
  if (!cfg) return null;
  if (dryRun) return cfg.serviceRoleKey ?? null;
  if (!cfg.serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to delete rows after a live message send. " +
        "Get it from Supabase → Settings → API Keys (secret). Never commit it.",
    );
  }
  return cfg.serviceRoleKey;
}
