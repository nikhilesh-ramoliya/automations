import type { CompanyRecord, PersonRecord, ServiceId } from "./types.js";
import { serviceLabel } from "./services.js";

export type OutreachTemplates = {
  linkedin: string;
  emailSubject: string;
  emailBody: string;
};

/** Multiple LinkedIn note phrasings — never blast identical connect messages. */
const LINKEDIN_NOTE_TEMPLATES = [
  "Hi {{firstName}}, I noticed {{company}} {{signalHint}}. We help teams with {{service}} — happy to share a short idea relevant to {{industryOrFocus}} if useful.",
  "Hi {{firstName}} — came across {{company}} and {{signalHint}}. At Lanatus we focus on {{service}}. Open to a brief intro if timing is right.",
  "{{firstName}}, {{company}} stood out ({{signalHint}}). We work with teams on {{service}}. Would welcome connecting.",
  "Hi {{firstName}}, exploring {{industryOrFocus}} at {{company}} and thought our {{service}} work might be relevant. Happy to connect.",
  "Hello {{firstName}}, noticed {{signalHint}} at {{company}}. We help with {{service}} — glad to share a concise idea if helpful.",
];

const EMAIL_SUBJECT_TEMPLATES = [
  "{{company}} × {{service}}",
  "Quick idea for {{company}} ({{service}})",
  "{{firstName}} — {{service}} at {{company}}",
];

const EMAIL_BODY_TEMPLATES = [
  "Hi {{firstName}},\n\nI came across {{company}}{{titleClause}} and noticed {{signalHint}}.\n\nAt Lanatus we help organizations with {{service}}. If you're exploring {{serviceShort}} this quarter, I'd welcome a brief conversation.\n\nBest regards",
  "Hi {{firstName}},\n\n{{company}}{{titleClause}} caught my attention — {{signalHint}}.\n\nWe partner with teams on {{service}}. If a short chat would be useful, I'm happy to share a tailored idea.\n\nBest regards",
  "Hello {{firstName}},\n\nReaching out about {{company}} given {{signalHint}}. Lanatus helps with {{service}} / {{serviceShort}}.\n\nOpen to connecting briefly if this is on your roadmap.\n\nBest regards",
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function firstName(full: string | undefined): string {
  if (!full) return "there";
  return full.trim().split(/\s+/)[0] || "there";
}

function signalHint(company: CompanyRecord): string {
  const hints = company.techSignals?.buyingHints ?? [];
  if (hints.length) return hints[0]!;
  if (company.techSignals?.careersMentionsHiring) {
    return "you're hiring for technical roles";
  }
  if (company.industry) return `operates in ${company.industry}`;
  return "may benefit from stronger software delivery";
}

export function draftOutreach(opts: {
  company: CompanyRecord;
  person?: PersonRecord;
  serviceId: ServiceId;
  serviceLabel?: string;
}): {
  channel: "linkedin" | "email";
  subject?: string;
  body: string;
  personalizedFrom: string[];
}[] {
  const company = opts.company;
  const person = opts.person;
  const svc = opts.serviceLabel ?? serviceLabel(opts.serviceId);
  const serviceShort = svc.toLowerCase();
  const industryOrFocus =
    company.industry ||
    company.techKeywords?.[0] ||
    company.specialties?.[0] ||
    "your roadmap";

  const vars: Record<string, string> = {
    firstName: firstName(person?.name),
    company: company.name,
    service: svc,
    serviceShort,
    signalHint: signalHint(company),
    industryOrFocus,
    titleClause: person?.title ? ` (${person.title})` : "",
  };

  const fill = (tpl: string) =>
    tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

  const liTpl = pick(LINKEDIN_NOTE_TEMPLATES);
  const subTpl = pick(EMAIL_SUBJECT_TEMPLATES);
  const bodyTpl = pick(EMAIL_BODY_TEMPLATES);

  const personalizedFrom = [
    `company:${company.name}`,
    person?.name ? `person:${person.name}` : "no_person",
    `service:${opts.serviceId}`,
    `signal:${vars.signalHint}`,
    `li_tpl:${LINKEDIN_NOTE_TEMPLATES.indexOf(liTpl)}`,
    `email_tpl:${EMAIL_BODY_TEMPLATES.indexOf(bodyTpl)}`,
  ];

  return [
    {
      channel: "linkedin",
      body: fill(liTpl),
      personalizedFrom,
    },
    {
      channel: "email",
      subject: fill(subTpl),
      body: fill(bodyTpl),
      personalizedFrom,
    },
  ];
}

/** Short post-accept DM templates (≤ ~300 chars after fill). */
const FOLLOWUP_MESSAGE_TEMPLATES = [
  "Hi {{firstName}} — thanks for connecting. Quick note: we help teams like {{company}} with {{service}}. Happy to share a short idea if useful.",
  "{{firstName}}, glad we connected. At Lanatus we focus on {{service}} — thought it might be relevant for {{company}}. Open to a brief chat anytime.",
  "Thanks for accepting, {{firstName}}. If {{company}} is exploring {{service}}, I'd welcome sharing one concise idea.",
  "Hi {{firstName}}, appreciated the connect. We partner with teams on {{service}}. Glad to trade notes if timing is right for {{company}}.",
  "{{firstName}} — thanks for connecting. Quick thought on {{service}} for {{company}}; happy to send a short outline if helpful.",
];

/**
 * Draft a short, varied LinkedIn follow-up after an accepted connection.
 * Uses firstName + company + recommended service; optional hook from prior LI draft.
 */
export function draftFollowupMessage(opts: {
  personName?: string;
  companyName: string;
  serviceLabel: string;
  /** Optional prior LinkedIn outreach body for a light hook (not pasted wholesale). */
  priorLinkedInDraft?: string;
}): { body: string; personalizedFrom: string[] } {
  const first = firstName(opts.personName);
  const company = opts.companyName.trim() || "your team";
  const service = opts.serviceLabel.trim() || "custom software";
  const tpl = pick(FOLLOWUP_MESSAGE_TEMPLATES);
  const vars: Record<string, string> = {
    firstName: first,
    company,
    service,
  };
  let body = tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

  // Light personalization from prior draft without repeating the full note
  const prior = opts.priorLinkedInDraft?.replace(/\s+/g, " ").trim();
  if (prior && prior.length > 40 && Math.random() < 0.35) {
    const hook = prior.slice(0, 60).replace(/\s+\S*$/, "").trim();
    if (hook.length > 20) {
      body = `Hi ${first} — following up after connecting. ${hook}… Happy to share how we approach ${service} for ${company} if useful.`;
    }
  }

  if (body.length > 300) {
    body = body.slice(0, 299).trimEnd() + "…";
  }

  return {
    body,
    personalizedFrom: [
      `person:${first}`,
      `company:${company}`,
      `service:${service}`,
      `tpl:${FOLLOWUP_MESSAGE_TEMPLATES.indexOf(tpl)}`,
    ],
  };
}
