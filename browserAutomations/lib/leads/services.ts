import type { ServiceId } from "./types.js";

export type OfferMap = Record<ServiceId, string>;

export const DEFAULT_OFFERS: OfferMap = {
  custom_software: "Custom software development",
  automation_rpa: "Automation / RPA",
  cloud_devops: "Cloud / DevOps",
  product_engineering: "Product engineering",
  it_consulting: "IT consulting",
};

const SERVICE_IDS: ServiceId[] = [
  "custom_software",
  "automation_rpa",
  "cloud_devops",
  "product_engineering",
  "it_consulting",
];

/**
 * Resolve offer labels from env:
 * - LEAD_OFFERS_JSON='{"custom_software":"..."}'
 * - or LEAD_OFFER_CUSTOM_SOFTWARE, LEAD_OFFER_AUTOMATION_RPA, etc.
 */
export function resolveOffers(): OfferMap {
  const offers: OfferMap = { ...DEFAULT_OFFERS };

  const json = process.env.LEAD_OFFERS_JSON?.trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, string>;
      for (const id of SERVICE_IDS) {
        if (typeof parsed[id] === "string" && parsed[id].trim()) {
          offers[id] = parsed[id].trim();
        }
      }
    } catch {
      // ignore bad JSON; keep defaults
    }
  }

  const envKey = (id: ServiceId): string =>
    `LEAD_OFFER_${id.toUpperCase()}`;

  for (const id of SERVICE_IDS) {
    const v = process.env[envKey(id)]?.trim();
    if (v) offers[id] = v;
  }

  return offers;
}

export function serviceLabel(id: ServiceId, offers?: OfferMap): string {
  return (offers ?? resolveOffers())[id] ?? id;
}

/** Keyword hints that map text → recommended service. */
export const SERVICE_KEYWORD_HINTS: Record<ServiceId, string[]> = {
  custom_software: [
    "custom software",
    "software development",
    "web app",
    "mobile app",
    "saas",
    "platform",
    "digital transformation",
  ],
  automation_rpa: [
    "automation",
    "rpa",
    "workflow",
    "process automation",
    "bot",
    "manual process",
    "spreadsheet",
  ],
  cloud_devops: [
    "cloud",
    "aws",
    "azure",
    "gcp",
    "devops",
    "kubernetes",
    "infrastructure",
    "migration",
  ],
  product_engineering: [
    "product",
    "mvp",
    "prototype",
    "engineering team",
    "product engineering",
    "scale product",
  ],
  it_consulting: [
    "it consulting",
    "strategy",
    "modernization",
    "legacy",
    "advisory",
    "digital strategy",
  ],
};
