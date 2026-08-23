import { truncateFollowupMessage } from "../leads/linkedin-message.js";

const DEFAULT_REFERRAL_TEMPLATE = `Hi, {{firstName}}
I'm seeking a Full Stack Developer role. I have 4 years of experience in React/Next, Node/Nest and AWS. Any openings in your company? I'd appreciate a referral. Thanks!`;

export function firstNameFromFullName(fullName: string): string {
  let name = fullName.trim();
  // Extension artifacts: "Dewankshi.now1/6", "Patel.now1/5"
  name = name.replace(/\.now\d+\/\d+$/i, "").trim();
  name = name.split(/\s+/)[0] ?? "there";
  if (name.toLowerCase() === "unknown" || name.toLowerCase() === "feed") {
    return "there";
  }
  return name;
}

export function isSkippableProfile(profileUrl: string, fullName: string): string | null {
  const url = profileUrl.trim();
  if (!url.includes("linkedin.com/in/")) {
    return "invalid_url";
  }
  if (url.includes("/in/_id/") || url.includes("urn%3Ali")) {
    return "urn_profile_url";
  }
  if (url.includes("/in/nikhilesh-ramoliya")) {
    return "own_profile";
  }
  const lower = fullName.toLowerCase();
  if (lower === "feed post" || lower.startsWith("feed ")) {
    return "feed_false_positive";
  }
  if (lower.includes("connections y") || lower.includes("'s connections")) {
    return "bad_capture_name";
  }
  return null;
}

export function draftConnectionMessage(opts: {
  fullName: string;
  template?: string;
}): string {
  const tpl = (
    opts.template?.trim() ||
    process.env.CONNECTION_FOLLOWUP_MESSAGE?.trim() ||
    DEFAULT_REFERRAL_TEMPLATE
  ).replace(/\\n/g, "\n");
  const firstName = firstNameFromFullName(opts.fullName);
  const body = tpl.replace(/\{\{firstName\}\}/g, firstName);
  return truncateFollowupMessage(body);
}
