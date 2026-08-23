import type { ConnectionRow } from "./types.js";

export type SupabaseCredentials = {
  url: string;
  key: string;
};

function headers(key: string, extra?: Record<string, string>): HeadersInit {
  const h: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
    ...extra,
  };
  if (key.startsWith("eyJ")) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message || body.error || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export async function fetchPendingConnections(
  cfg: SupabaseCredentials,
  limit?: number,
): Promise<ConnectionRow[]> {
  const params = new URLSearchParams({
    select: "*",
    status: "eq.pending",
    order: "requested_at.asc",
  });
  if (limit) params.set("limit", String(limit));

  const res = await fetch(
    `${cfg.url}/rest/v1/connection_requests?${params}`,
    { headers: headers(cfg.key) },
  );
  if (!res.ok) throw new Error(`Supabase fetch failed: ${await parseError(res)}`);
  return (await res.json()) as ConnectionRow[];
}

/** Remove row after successful message send (requires service_role key). */
export async function deleteConnection(
  cfg: SupabaseCredentials,
  id: string,
): Promise<void> {
  const res = await fetch(
    `${cfg.url}/rest/v1/connection_requests?id=eq.${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: headers(cfg.key, { Prefer: "return=minimal" }),
    },
  );
  if (!res.ok) {
    throw new Error(`Supabase delete failed: ${await parseError(res)}`);
  }
}

export async function testSupabaseConnection(
  cfg: SupabaseCredentials,
): Promise<void> {
  const res = await fetch(
    `${cfg.url}/rest/v1/connection_requests?select=id&limit=1`,
    { headers: headers(cfg.key) },
  );
  if (!res.ok) throw new Error(await parseError(res));
}
