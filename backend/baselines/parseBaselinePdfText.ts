import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseBaselineRank, isSearchEngineDomainCell, isWebsiteCell } from "./normalizeKeyword.js";
import { parseDateLabel, pickNewestDateColumn } from "./parseDateColumn.js";
import { normalizeSeDomain } from "../dataforseo/buildRequest.js";
import type { BaselinePreview, BaselinePreviewRow } from "./parseBaselineExcel.js";

// Reads a ranking report PDF from its TEXT LAYER -- exact and fast. Report PDFs
// produced by this app (and the agency's own report PDFs, which use the same
// layout) are real text, not scans; the OCR path (parseBaselinePdf.ts) could
// not even find the "Keyword" header in them (Twin Crown, 2026-10-07). Returns
// null when the PDF has no usable text table (e.g. a scanned image), so the
// caller can fall back to OCR.

interface Item {
  text: string;
  x: number; // left edge
  cx: number; // horizontal center
}

/** Lines of text in reading order across all pages, each line's items left-to-right. */
async function readLines(pdfBuffer: Buffer): Promise<Item[][]> {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const lines: Item[][] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const content = await (await pdf.getPage(pageNumber)).getTextContent();
    const byY = new Map<number, Item[]>();
    for (const raw of content.items as { str?: string; transform?: number[]; width?: number }[]) {
      const text = (raw.str ?? "").trim();
      if (!text || !raw.transform) continue;
      const x = raw.transform[4];
      const y = Math.round(raw.transform[5]);
      // Merge baselines within 2pt (same visual row).
      let key = y;
      for (const k of byY.keys()) if (Math.abs(k - y) <= 2) key = k;
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key)!.push({ text, x, cx: x + (raw.width ?? 0) / 2 });
    }
    [...byY.keys()].sort((a, b) => b - a).forEach((y) => lines.push(byY.get(y)!.sort((a, b) => a.x - b.x)));
  }
  return lines;
}

export async function parseBaselinePdfText(pdfBuffer: Buffer): Promise<BaselinePreview | null> {
  let lines: Item[][];
  try {
    lines = await readLines(pdfBuffer);
  } catch {
    return null;
  }

  // Header: a line with a "Keyword" label and at least one date label.
  const headerIndex = lines.findIndex(
    (line) => line.some((i) => /^keywords?:?$/i.test(i.text)) && line.some((i) => parseDateLabel(i.text) !== null),
  );
  if (headerIndex < 0) return null;
  const header = lines[headerIndex];
  const dateColumns = header.filter((i) => parseDateLabel(i.text)).map((i) => ({ label: i.text, cx: i.cx }));
  const otherHeaderColumns = header.filter((i) => !parseDateLabel(i.text) && !/^keywords?:?$/i.test(i.text)).map((i) => i.cx);
  const newest = pickNewestDateColumn(dateColumns.map((d, index) => ({ label: d.label, index })));
  if (!newest) return null;

  // Anything left of the first date column (minus half a column) is the keyword.
  const sortedCenters = dateColumns.map((d) => d.cx).sort((a, b) => a - b);
  const halfGap = sortedCenters.length > 1 ? (sortedCenters[1] - sortedCenters[0]) / 2 : 60;
  const keywordMaxX = sortedCenters[0] - halfGap;
  const columns = [...dateColumns.map((d, index) => ({ cx: d.cx, dateIndex: index as number | null })), ...otherHeaderColumns.map((cx) => ({ cx, dateIndex: null }))];
  const nearestColumn = (cx: number) => columns.reduce((best, c) => (Math.abs(c.cx - cx) < Math.abs(best.cx - cx) ? c : best), columns[0]);

  // Title block above the header: website + the "Current Ranking Status: | Google.ae" domain.
  let clientDomain: string | null = null;
  let primarySearchDomain: string | null = null;
  for (const line of lines.slice(0, headerIndex)) {
    for (const item of line) {
      if (!primarySearchDomain && isSearchEngineDomainCell(item.text)) primarySearchDomain = normalizeSeDomain(item.text);
      else if (!clientDomain && isWebsiteCell(item.text)) clientDomain = item.text.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
    }
  }

  const rows: BaselinePreviewRow[] = [];
  const sections: { name: string; domain: string }[] = [];
  let currentSection: string | null = null;
  for (const line of lines.slice(headerIndex + 1)) {
    const keyword = line.filter((i) => i.cx < keywordMaxX && i.x < keywordMaxX).map((i) => i.text).join(" ").replace(/\s+/g, " ").trim();
    const values: string[] = dateColumns.map(() => "");
    for (const item of line) {
      if (item.cx < keywordMaxX && item.x < keywordMaxX) continue;
      const col = nearestColumn(item.cx);
      if (col.dateIndex !== null) values[col.dateIndex] = (values[col.dateIndex] + " " + item.text).trim();
    }
    // A repeated header on a later page is skipped, not read as a keyword.
    if (/^keywords?:?$/i.test(keyword) || /^current ranking status:?$/i.test(keyword)) continue;
    if (!keyword) continue;
    const sectionDomain = values.find((v) => isSearchEngineDomainCell(v));
    if (sectionDomain) {
      currentSection = keyword;
      sections.push({ name: keyword, domain: normalizeSeDomain(sectionDomain) });
      continue;
    }
    // A data row has something in at least one date column; anything else (footer text, page numbers) is ignored.
    if (values.every((v) => !v)) continue;
    const { rankValue, rankDisplay } = parseBaselineRank(values[newest.column.index]);
    rows.push({ keyword, rankValue, rankDisplay, section: currentSection });
  }
  if (rows.length === 0) return null;

  return {
    detectedDates: dateColumns.map((d) => ({ label: d.label, isoDate: (parseDateLabel(d.label) as Date).toISOString() })),
    baselineDate: newest.date.toISOString(),
    baselineDateLabel: newest.column.label,
    rows,
    sections,
    primarySearchDomain,
    clientDomain,
  };
}
