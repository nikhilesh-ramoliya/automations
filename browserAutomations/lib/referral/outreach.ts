/** Static connect note + referral DM templates. */

const DEFAULT_CONNECT_NOTE =
  "Hi {{firstName}}, I'm a Full Stack / MERN / React developer exploring roles in {{geo}}. Would love to connect.";

const DEFAULT_REFERRAL_MESSAGE =
  "Hi {{firstName}}, I'm a Full Stack / MERN / React developer. I saw the {{jobTitle}} opening at {{company}} and would really appreciate a referral if possible. Thanks!";

function firstName(full: string | undefined): string {
  if (!full) return "there";
  return full.trim().split(/\s+/)[0] || "there";
}

function fill(
  template: string,
  vars: Record<string, string>,
): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out.replace(/\s+/g, " ").trim();
}

export function draftConnectNote(opts: {
  personName?: string;
  geo: string;
}): string {
  const template =
    process.env.REFERRAL_CONNECT_NOTE?.trim() || DEFAULT_CONNECT_NOTE;
  const note = fill(template, {
    firstName: firstName(opts.personName),
    geo: opts.geo || "India",
  });
  // LinkedIn connection notes max ~300; keep under 280 for safety
  if (note.length <= 280) return note;
  return note.slice(0, 279).trimEnd() + "…";
}

export function draftReferralMessage(opts: {
  personName?: string;
  companyName: string;
  jobTitle: string;
}): string {
  const template =
    process.env.REFERRAL_MESSAGE?.trim() || DEFAULT_REFERRAL_MESSAGE;
  const msg = fill(template, {
    firstName: firstName(opts.personName),
    company: opts.companyName || "your company",
    jobTitle: opts.jobTitle || "open role",
  });
  if (msg.length <= 300) return msg;
  return msg.slice(0, 299).trimEnd() + "…";
}
