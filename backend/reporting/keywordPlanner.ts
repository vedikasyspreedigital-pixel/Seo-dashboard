import ExcelJS from "exceljs";

/**
 * Keyword Planner numbers for the Baseline Report (2026-11-10). Two free ways in:
 *   1. The team's Keyword Planner download ("Get search volume and forecasts" -> Download keyword ideas):
 *      a .csv (UTF-16, tab-separated, two title lines before the header) or the Google Sheets/.xlsx version.
 *   2. The Google Ads API's generateKeywordHistoricalMetrics -- the same numbers, fetched by the dashboard, once
 *      the team's developer token is approved (GOOGLE_ADS_* variables).
 * Both give, per keyword, "Avg. monthly searches" and "Competition" exactly as Google gave them; the team's
 * buckets (50 / 500 / 5000, "Unknown") are applied when the report is built (baselineColumns.ts).
 */

export interface PlannerMetric {
  keyword: string;
  avgMonthlySearches: string | null;
  competition: string | null;
}

export class KeywordPlannerFileError extends Error {}

function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  // UTF-16 without a BOM: every other byte is 0 for plain text.
  if (buffer.length > 4 && buffer[1] === 0 && buffer[3] === 0) return buffer.toString("utf16le");
  return buffer.toString("utf8").replace(/^﻿/, "");
}

/** One CSV/TSV line -> cells (quotes handled). */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Rows of cells -> metrics, from the row that has "Keyword" and "Avg. monthly searches". */
export function metricsFromTable(rows: string[][]): PlannerMetric[] {
  const headerIndex = rows.findIndex((r) => r.some((c) => /^keywords?$/i.test(c)) && r.some((c) => /avg\.?\s*monthly\s*searches/i.test(c)));
  if (headerIndex < 0) {
    throw new KeywordPlannerFileError('This doesn\'t look like a Keyword Planner download: no header row with "Keyword" and "Avg. monthly searches" was found.');
  }
  const header = rows[headerIndex];
  const kCol = header.findIndex((c) => /^keywords?$/i.test(c));
  const vCol = header.findIndex((c) => /avg\.?\s*monthly\s*searches/i.test(c));
  const cCol = header.findIndex((c) => /^competition$/i.test(c));
  const out: PlannerMetric[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const keyword = (row[kCol] ?? "").trim();
    if (!keyword) continue;
    out.push({ keyword, avgMonthlySearches: (row[vCol] ?? "").trim() || null, competition: cCol >= 0 ? (row[cCol] ?? "").trim() || null : null });
  }
  if (out.length === 0) throw new KeywordPlannerFileError("The Keyword Planner file has a header but no keyword rows.");
  return out;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join("").trim();
    if (o.result !== undefined && o.result !== null) return String(o.result).trim();
    if (typeof o.text === "string") return o.text.trim();
    return "";
  }
  return String(v).trim();
}

/** The team's Keyword Planner download (.csv or .xlsx) -> metrics per keyword. */
export async function readKeywordPlannerFile(buffer: Buffer, filename: string): Promise<PlannerMetric[]> {
  const isXlsx = /\.xlsx$/i.test(filename) || (buffer[0] === 0x50 && buffer[1] === 0x4b); // "PK" = zip
  if (isXlsx) {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new KeywordPlannerFileError("This file couldn't be opened as an Excel (.xlsx) file.");
    }
    let lastError: unknown;
    for (const ws of workbook.worksheets) {
      const rows: string[][] = [];
      for (let r = 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= Math.max(ws.columnCount, 1); c++) cells.push(cellText(row.getCell(c)));
        rows.push(cells);
      }
      try {
        return metricsFromTable(rows);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new KeywordPlannerFileError("No Keyword Planner table found in the file.");
  }
  const text = decodeText(buffer);
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const headerLine = lines.find((l) => /avg\.?\s*monthly\s*searches/i.test(l)) ?? lines[0] ?? "";
  const delimiter = headerLine.includes("\t") ? "\t" : headerLine.includes(";") && !headerLine.includes(",") ? ";" : ",";
  return metricsFromTable(lines.map((l) => splitLine(l, delimiter)));
}

// ---------------------------------------------------------------- Google Ads API

/** Google Ads location ids for the clients' countries (geoTargetConstants/<id>). */
const GEO_TARGETS: Record<string, { id: number; name: string }> = {
  AU: { id: 2036, name: "Australia" },
  IN: { id: 2356, name: "India" },
  AE: { id: 2784, name: "United Arab Emirates" },
  US: { id: 2840, name: "United States" },
  GB: { id: 2826, name: "United Kingdom" },
  NZ: { id: 2554, name: "New Zealand" },
  CA: { id: 2124, name: "Canada" },
  SG: { id: 2702, name: "Singapore" },
  SA: { id: 2682, name: "Saudi Arabia" },
  QA: { id: 2634, name: "Qatar" },
  ZA: { id: 2710, name: "South Africa" },
  IE: { id: 2372, name: "Ireland" },
};

/** Handover Step 0: the country from the Google domain the run searched ("google.com.au" -> AU). */
export function countryOfSeDomain(seDomain: string | null | undefined): string | null {
  const host = String(seDomain ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (!host) return null;
  if (host === "google.com") return "US";
  const tld = host.split(".").pop() ?? "";
  const map: Record<string, string> = { au: "AU", in: "IN", ae: "AE", uk: "GB", nz: "NZ", ca: "CA", sg: "SG", sa: "SA", qa: "QA", za: "ZA", ie: "IE" };
  return map[tld] ?? null;
}

export function geoTargetOf(country: string | null) {
  return country ? (GEO_TARGETS[country] ?? null) : null;
}

// GOOGLE_ADS_DEVELOPER_TOKEN is optional: Google moved API access levels to the Google Cloud project on
// 2026-09-09 (developer tokens "sunset"); the header is still sent when the variable is set.
const REQUIRED_ENV = ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"] as const;

/** True once every Google Ads API variable is set on the server. */
export function googleAdsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED_ENV.every((k) => !!env[k]?.trim());
}

export class GoogleAdsError extends Error {}

const digitsOnly = (id: string) => id.replace(/\D/g, "");

/**
 * Keyword Planner's historical metrics for `keywords` in `country`, via the Google Ads API (free; needs the
 * team's approved developer token). Keyword Planner's merged keywords (same words, other order) come back as
 * closeVariants -- each gets the merged figures too.
 */
export async function fetchGoogleAdsMetrics(
  keywords: string[],
  country: string,
  { fetchImpl = fetch, env = process.env }: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<PlannerMetric[]> {
  if (!googleAdsConfigured(env)) throw new GoogleAdsError("The Google Ads API isn't set up on the server yet (GOOGLE_ADS_* variables).");
  const geo = geoTargetOf(country);
  if (!geo) throw new GoogleAdsError(`No Google Ads location is set up for country "${country}".`);

  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID!.trim(),
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET!.trim(),
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN!.trim(),
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenRes.ok || !token.access_token) {
    throw new GoogleAdsError(`Google sign-in for the Ads API failed (${token.error ?? tokenRes.status}${token.error_description ? `: ${token.error_description}` : ""}) -- the refresh token may need renewing.`);
  }

  const version = env.GOOGLE_ADS_API_VERSION?.trim() || "v24";
  const customerId = digitsOnly(env.GOOGLE_ADS_CUSTOMER_ID!);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
  };
  if (env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim()) headers["developer-token"] = env.GOOGLE_ADS_DEVELOPER_TOKEN.trim();
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim()) headers["login-customer-id"] = digitsOnly(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);

  const out: PlannerMetric[] = [];
  const unique = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 1000) {
    const res = await fetchImpl(`https://googleads.googleapis.com/${version}/customers/${customerId}:generateKeywordHistoricalMetrics`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        keywords: unique.slice(i, i + 1000),
        geoTargetConstants: [`geoTargetConstants/${geo.id}`],
        language: "languageConstants/1000", // English
        keywordPlanNetwork: "GOOGLE_SEARCH",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      results?: { text?: string; closeVariants?: string[]; keywordMetrics?: { avgMonthlySearches?: string | number; competition?: string } }[];
      error?: { message?: string; status?: string };
    };
    if (!res.ok) throw new GoogleAdsError(`The Google Ads API refused the request (${body.error?.status ?? res.status}): ${body.error?.message ?? "no details"}`);
    for (const r of body.results ?? []) {
      const m = r.keywordMetrics;
      const metric = {
        avgMonthlySearches: m?.avgMonthlySearches !== undefined && m?.avgMonthlySearches !== null ? String(m.avgMonthlySearches) : null,
        competition: m?.competition ?? null,
      };
      if (r.text) out.push({ keyword: r.text, ...metric });
      for (const v of r.closeVariants ?? []) out.push({ keyword: v, ...metric });
    }
  }
  return out;
}
