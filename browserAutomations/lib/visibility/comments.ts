/**
 * Meaningful comment drafts for targeted engagement.
 * Avoid empty praise ("Great post!") — prefer specific, expertise-signaling replies.
 */

import type { FoundPost } from "./types.js";

function firstSentenceHook(text: string): string | undefined {
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 40) return undefined;
  // Prefer a concrete phrase (numbers, outcomes, tech nouns)
  const num = cleaned.match(
    /\b(?:\d+%|\d+x|latency|checkout|API|automation|RPA|LLM|GenAI|refactor|deploy|pipeline|retail|SaaS)\b[^.]{0,80}/i,
  );
  if (num) return num[0]!.trim().slice(0, 100);
  const sent = cleaned.split(/[.!?]/)[0]?.trim();
  if (sent && sent.length >= 40 && sent.length <= 140) return sent;
  return cleaned.slice(0, 90).trim();
}

/**
 * Draft a thoughtful comment grounded in the post — not generic engagement bait.
 */
export function draftMeaningfulComment(
  post: FoundPost,
  opts?: { authorFirstName?: string },
): string {
  const t = post.text;
  const lower = t.toLowerCase();
  const hook = firstSentenceHook(t);
  const name = opts?.authorFirstName;

  // Reject thin posts — caller should skip commenting
  if (
    /the author can see how you vote|show results|\b\d+\s*votes?\b/i.test(t) ||
    t.replace(/\s+/g, " ").trim().length < 80
  ) {
    return "";
  }

  if (/\b(api|latency|checkout|performance|throughput)\b/i.test(lower)) {
    return (
      (name ? `${name}, ` : "") +
      "We've seen something similar with a retail client — reducing checkout API latency " +
      "moved completed orders more than frontend tweaks alone. " +
      (hook ? `Your note on ${hook.toLowerCase()} resonates. ` : "") +
      "Curious if you've measured the same trade-off."
    );
  }

  if (/\b(ai|genai|llm|agent|copilot|ml)\b/i.test(lower)) {
    return (
      "The teams I work with get the most value when GenAI sits on clear process and review, " +
      "not just a model demo. " +
      (hook ? `Agree with the angle on “${hook.slice(0, 70)}”. ` : "") +
      "What’s been the hardest part to operationalize on your side?"
    );
  }

  if (/\b(automat|rpa|workflow|manual)\b/i.test(lower)) {
    return (
      "This matches what we see in delivery: durable automation starts with the messy edge cases — " +
      "once those are designed for, the happy path almost takes care of itself. " +
      "Would love to hear which process you tackled first."
    );
  }

  if (/\b(engineer|architecture|platform|refactor|tech debt|deploy)\b/i.test(lower)) {
    return (
      "Appreciate the concrete takeaways. Custom software pays off when it removes real friction " +
      "for the people who ship every week — not when it’s a greenfield rewrite for its own sake. " +
      (hook ? `The point about ${hook.toLowerCase()} is especially useful. ` : "") +
      "How are you sequencing the next iteration?"
    );
  }

  if (/\b(consult|transform|advisory|stakeholder)\b/i.test(lower)) {
    return (
      "Well said. The consulting work that sticks is less about slides and more about helping a team " +
      "ship one concrete improvement they can own. " +
      "Curious which change landed fastest with your stakeholders."
    );
  }

  if (hook) {
    return (
      `Strong point on “${hook.slice(0, 85)}”. ` +
      "We've run into a similar pattern with engineering leaders — the unlock is usually operationalizing " +
      "the insight, not just agreeing with it. Happy to compare notes on what worked in practice."
    );
  }

  return (
    "Clear takeaways — especially the focus on outcomes over tooling theater. " +
    "We've seen the same with teams shipping custom software: small, measured changes beat big bangs. " +
    "Curious which experiment you'd run next."
  );
}

/** Short personalized connection note (≤280 when truncated by connect helper). */
export function draftConnectNote(opts: {
  firstName?: string;
  title?: string;
  postHook?: string;
}): string {
  const first = (opts.firstName || "there").trim().split(/\s+/)[0] || "there";
  const hook = opts.postHook?.slice(0, 70);
  const variants = [
    hook
      ? `Hi ${first} — appreciated your point about ${hook}. I work with teams on custom software and automation; glad to connect.`
      : `Hi ${first} — came across your profile${opts.title ? ` (${opts.title.slice(0, 40)})` : ""}. I work with engineering leaders on custom software / automation. Happy to connect.`,
    `Hi ${first}, enjoyed your recent post${hook ? ` on ${hook}` : ""}. Building in public around software delivery and automation — would welcome connecting.`,
    `${first}, thanks for sharing practical engineering insights. I partner with teams on IT consulting and custom builds — open to connecting if useful.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)]!;
}
