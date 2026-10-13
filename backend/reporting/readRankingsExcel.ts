import ExcelJS from "exceljs";
import { parseRankingExcel } from "../excel/parser.js";
import { normalizeSeDomain, normalizeMatchDomain } from "../dataforseo/buildRequest.js";

// Reads a run's RANKINGS EXCEL (Keywords / Full URL / URL / Concatenate /
// Location / Domain / Language / Status / Ranks / Ranking url) for the Compare
// Reports tab, with the same parser the run upload uses. The file has no date
// inside -- the user picks it on screen. Client website = Full URL column,
// Google + country = Domain + Location columns.

export interface RankingsExcelRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
  /** "Australia|google.com.au" -- same key the client PDF groups by (buildReport.loadRowLocations). */
  location: string;
}

export interface RankingsExcel {
  sheetName: string;
  rows: RankingsExcelRow[];
  clientDomain: string | null;
  /** Rows the parser skipped (missing Keywords/URL/Location/Domain/Language/Status, or an unknown Status). */
  skippedRows: { sourceRowNumber: number; reason: string }[];
}

export class RankingsExcelError extends Error {}

export function locationKey(locationName: string, seDomain: string): string {
  return locationName.trim() + "|" + normalizeSeDomain(seDomain);
}

/** "Australia|google.com.au" -> its parts. */
export function splitLocationKey(key: string): { locationName: string; seDomain: string } {
  const i = key.lastIndexOf("|");
  return i < 0 ? { locationName: key, seDomain: "" } : { locationName: key.slice(0, i), seDomain: key.slice(i + 1) };
}

/**
 * Uses the first sheet laid out as a rankings Excel (a workbook that also has
 * a report sheet, like "all_bathrooms_and_tiling_15th_Sep_FINAL.xlsx" with
 * "Ranking" + "Sheet1", reads Sheet1).
 */
export async function readRankingsExcel(buffer: Buffer): Promise<RankingsExcel> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new RankingsExcelError("This isn't an Excel (.xlsx) file.");
  }

  let firstError: string | null = null;
  for (const ws of workbook.worksheets) {
    let parsed: { rows: any[]; rowErrors: any[] };
    try {
      parsed = await parseRankingExcel(buffer, { clientId: "compare-reports", worksheetName: ws.name });
    } catch (err) {
      firstError ??= (err as Error).message;
      continue; // not a rankings sheet (e.g. the formatted "Ranking" report sheet)
    }
    if (parsed.rows.length === 0) continue;
    return {
      sheetName: ws.name,
      rows: parsed.rows.map((r) => ({
        keyword: r.keyword,
        rankValue: r.rankValue,
        rankDisplay: r.rankDisplay,
        location: locationKey(r.locationName, r.seDomain),
      })),
      clientDomain: parsed.rows.map((r) => normalizeMatchDomain(r.fullUrl)).find(Boolean) ?? null,
      skippedRows: parsed.rowErrors.map((e) => ({ sourceRowNumber: e.sourceRowNumber, reason: e.reason })),
    };
  }
  throw new RankingsExcelError(
    `No rankings sheet found. It needs the columns Keywords, Full URL, URL, Concatenate, Location, Domain, Language, Status, Ranks, Ranking url${firstError ? ` (${firstError})` : ""}.`,
  );
}

/**
 * "all_bathrooms_and_tiling_15th_Sep_FINAL.xlsx" -> "All Bathrooms and Tiling",
 * "Mr Whirly Bird - Final rankings.xlsx" -> "Mr Whirly Bird". Editable on screen.
 */
export function clientNameFromFileName(fileName: string): string {
  let name = fileName
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/_+/g, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?[\s-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:[\s-]+\d{4})?\b/gi, " ")
    .replace(/\b(?:final|rankings?|keyword ranking report|report|excel|copy|v\d+)\b/gi, " ")
    .replace(/\(\d+\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–]+|[\s\-–]+$/g, "")
    .trim();
  if (name && name === name.toLowerCase()) {
    const small = new Set(["and", "of", "the", "for", "in", "on", "at", "by"]);
    name = name.split(" ").map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  }
  return name || "Client";
}
