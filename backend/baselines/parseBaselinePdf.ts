import { renderPdfPageImages } from "./renderPdfPageImages.js";
import { ocrExtractTablePage } from "./ocrExtractTable.js";
import { parseBaselineRank, isSearchEngineDomainCell } from "./normalizeKeyword.js";
import { normalizeSeDomain } from "../dataforseo/buildRequest.js";
import { parseBaselinePdfText } from "./parseBaselinePdfText.js";
import { parseDateLabel, pickNewestDateColumn } from "./parseDateColumn.js";
import type { BaselinePreview, BaselinePreviewRow } from "./parseBaselineExcel.js";

export async function parseBaselinePdf(pdfBuffer: Buffer): Promise<BaselinePreview> {
  // Text-based report PDFs (this app's own, and the agency's) are read exactly
  // from their text layer; only a scanned/image PDF falls through to OCR.
  const fromText = await parseBaselinePdfText(pdfBuffer);
  if (fromText) return fromText;

  const pageImages = await renderPdfPageImages(pdfBuffer);
  if (pageImages.length === 0) throw new Error("The uploaded PDF has no pages.");

  let headerDatePhrases: string[] | null = null;
  const ocrRows: { keyword: string; values: string[] }[] = [];
  for (const image of pageImages) {
    const page = await ocrExtractTablePage(image);
    if (page.headerDatePhrases && !headerDatePhrases) headerDatePhrases = page.headerDatePhrases;
    ocrRows.push(...page.rows);
  }

  if (!headerDatePhrases) {
    throw new Error('Could not find a "Keyword" header row anywhere in the scanned PDF -- the OCR extraction may have failed on this file\'s layout.');
  }

  const dateColumns = headerDatePhrases
    .map((label) => ({ label, date: parseDateLabel(label) }))
    .filter((c): c is { label: string; date: Date } => c.date !== null);
  if (dateColumns.length === 0) {
    throw new Error("Found a Keyword header row, but none of its other columns could be read as a date.");
  }

  const newest = pickNewestDateColumn(dateColumns);
  if (!newest) throw new Error("Could not determine the most recent date column.");
  const newestColumnIndex = dateColumns.findIndex((c) => c.label === newest.column.label);

  const rows: BaselinePreviewRow[] = [];
  const sections: { name: string; domain: string }[] = [];
  let currentSection: string | null = null;
  for (const ocrRow of ocrRows) {
    if (!ocrRow.keyword) continue;
    // A location section heading ("Saudi Arabia | google.com.sa | ..."), not
    // a keyword: remembered, and every row below it belongs to it.
    const sectionDomain = ocrRow.values.find((v) => isSearchEngineDomainCell(v));
    if (sectionDomain) {
      currentSection = ocrRow.keyword;
      sections.push({ name: ocrRow.keyword, domain: normalizeSeDomain(sectionDomain) });
      continue;
    }
    const rawValue = ocrRow.values[newestColumnIndex];
    const { rankValue, rankDisplay } = parseBaselineRank(rawValue);
    rows.push({ keyword: ocrRow.keyword, rankValue, rankDisplay, section: currentSection });
  }

  return {
    detectedDates: dateColumns.map((c) => ({ label: c.label, isoDate: c.date.toISOString() })),
    baselineDate: newest.date.toISOString(),
    baselineDateLabel: newest.column.label,
    rows,
    sections,
  };
}
