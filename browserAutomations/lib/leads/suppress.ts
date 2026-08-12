import fs from "node:fs";
import path from "node:path";
import { LEADS_SUPPRESS_DIR, normalizeCompanyName, normalizeUrl } from "./io.js";

export type SuppressLists = {
  companyNames: Set<string>;
  companyUrls: Set<string>;
  personUrls: Set<string>;
  personNames: Set<string>;
};

function loadLinesOrJson(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter(Boolean);
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const lists = [
          obj.companies,
          obj.names,
          obj.urls,
          obj.people,
          obj.entries,
        ];
        const out: string[] = [];
        for (const list of lists) {
          if (Array.isArray(list)) {
            for (const item of list) {
              if (typeof item === "string") out.push(item);
              else if (item && typeof item === "object") {
                const rec = item as Record<string, unknown>;
                for (const k of ["name", "url", "linkedinUrl", "websiteUrl"]) {
                  if (typeof rec[k] === "string") out.push(String(rec[k]));
                }
              }
            }
          }
        }
        return out.filter(Boolean);
      }
    } catch {
      // fall through to line/csv parse
    }
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\uFEFF/, "").split(",")[0]?.trim() ?? "")
    .filter((l) => l && !l.startsWith("#") && l.toLowerCase() !== "name");
}

export function loadSuppressLists(): SuppressLists {
  const companyFile =
    process.env.LEAD_SUPPRESS_COMPANIES?.trim() ||
    path.join(LEADS_SUPPRESS_DIR, "companies.example.csv");
  const peopleFile =
    process.env.LEAD_SUPPRESS_PEOPLE?.trim() ||
    path.join(LEADS_SUPPRESS_DIR, "people.example.csv");

  const companyEntries = loadLinesOrJson(companyFile);
  const peopleEntries = loadLinesOrJson(peopleFile);

  const companyNames = new Set<string>();
  const companyUrls = new Set<string>();
  const personUrls = new Set<string>();
  const personNames = new Set<string>();

  for (const e of companyEntries) {
    if (/^https?:\/\//i.test(e) || e.includes("linkedin.com")) {
      const n = normalizeUrl(e);
      if (n) companyUrls.add(n);
    } else {
      companyNames.add(normalizeCompanyName(e));
    }
  }
  for (const e of peopleEntries) {
    if (/^https?:\/\//i.test(e) || e.includes("linkedin.com")) {
      const n = normalizeUrl(e);
      if (n) personUrls.add(n);
    } else {
      personNames.add(e.toLowerCase().trim());
    }
  }

  return { companyNames, companyUrls, personUrls, personNames };
}

export function isCompanySuppressed(
  name: string,
  linkedinUrl: string | undefined,
  websiteUrl: string | undefined,
  lists: SuppressLists,
): string | undefined {
  const nn = normalizeCompanyName(name);
  if (nn && lists.companyNames.has(nn)) return `name:${nn}`;
  for (const u of [linkedinUrl, websiteUrl]) {
    const n = normalizeUrl(u);
    if (n && lists.companyUrls.has(n)) return `url:${n}`;
  }
  return undefined;
}

export function isPersonSuppressed(
  name: string,
  linkedinUrl: string | undefined,
  lists: SuppressLists,
): string | undefined {
  const nurl = normalizeUrl(linkedinUrl);
  if (nurl && lists.personUrls.has(nurl)) return `url:${nurl}`;
  const nn = name.toLowerCase().trim();
  if (nn && lists.personNames.has(nn)) return `name:${nn}`;
  return undefined;
}
