/** Mirrors linkedIn-connection-extension/src/shared/types.ts */

export type ConnectionStatus = "pending" | "accepted" | "withdrawn";

export type ConnectionRow = {
  id: string;
  profile_url: string;
  profile_id: string | null;
  full_name: string;
  headline: string | null;
  company: string | null;
  invitation_note: string | null;
  source: string | null;
  status: ConnectionStatus;
  requested_at: string;
  created_at: string;
};

export type ConnectionFollowupResult = {
  id: string;
  profileUrl: string;
  fullName: string;
  status: "messaged" | "pending" | "skipped" | "error";
  detail?: string;
  messagePreview?: string;
  deletedFromSupabase?: boolean;
  dryRun: boolean;
  ok: boolean;
  followedUpAt: string;
};
