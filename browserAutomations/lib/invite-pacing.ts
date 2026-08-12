/**
 * Monthly invite pacing: spread remaining LinkedIn Page invite credits
 * evenly across the rest of the current calendar month.
 *
 * remainingDays counts **including today**:
 *   lastDayOfMonth - todayDate + 1
 * e.g. day 7 in a 31-day month → 25 days.
 *
 * batchSize = Math.ceil(remainingCredits / remainingDays)  (min 0; 0 days → 0)
 * INVITE_MAX (if set) caps that value unless INVITE_MAX_MODE=override.
 */

export type ParsedCredits = {
  remaining: number;
  total: number;
  /** Matched fragment, e.g. "50/50" */
  matched: string;
};

/**
 * Parse "X/Y" credit counters from invite modal text.
 * Accepts forms like "50/50 credits available" or "12 / 50".
 */
export function parseInviteCredits(text: string): ParsedCredits | null {
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  const remaining = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(remaining) || !Number.isFinite(total)) return null;
  return { remaining, total, matched: `${remaining}/${total}` };
}

/**
 * Days left in the current month **including today** (local Date).
 * Uses the process timezone (set TZ if you need a fixed zone).
 */
export function remainingDaysInMonth(now: Date = new Date()): number {
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = now.getDate();
  const lastDay = new Date(year, month + 1, 0).getDate();
  return Math.max(0, lastDay - today + 1);
}

export type InviteMaxMode = "cap" | "override";

export type BatchComputation = {
  /** Final invites to send this run */
  batchSize: number;
  /** ceil(credits / days) before INVITE_MAX */
  computed: number;
  remainingCredits: number;
  remainingDays: number;
  inviteMax?: number;
  inviteMaxMode: InviteMaxMode;
};

export function computeInviteBatchSize(opts: {
  remainingCredits: number;
  remainingDays: number;
  /** Optional: cap (default) or replace computed size */
  inviteMax?: number;
  inviteMaxMode?: InviteMaxMode;
}): BatchComputation {
  const remainingCredits = Math.max(0, Math.floor(opts.remainingCredits));
  const remainingDays = Math.max(0, Math.floor(opts.remainingDays));
  const inviteMaxMode: InviteMaxMode =
    opts.inviteMaxMode === "override" ? "override" : "cap";

  const computed =
    remainingDays > 0
      ? Math.ceil(remainingCredits / remainingDays)
      : 0;

  let batchSize = Math.max(0, computed);

  if (opts.inviteMax !== undefined && Number.isFinite(opts.inviteMax)) {
    const max = Math.max(0, Math.floor(opts.inviteMax));
    if (inviteMaxMode === "override") {
      batchSize = Math.min(max, remainingCredits);
    } else {
      batchSize = Math.min(batchSize, max);
    }
  }

  // Never exceed remaining credits
  batchSize = Math.min(batchSize, remainingCredits);

  return {
    batchSize,
    computed,
    remainingCredits,
    remainingDays,
    inviteMax: opts.inviteMax,
    inviteMaxMode,
  };
}
