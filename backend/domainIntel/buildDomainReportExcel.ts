import ExcelJS from "exceljs";
import { SOURCE_LABELS, type KeywordRow, type KeywordSource } from "./readKeywordExport.js";
import { brandTerms, matchesBrand } from "./classifyIntent.js";

// Domain Intelligence Excel layout, matching the agreed sample: one block per
// tool side by side on a single sheet, each with a yellow title row (the
// tool's name) over a blue header row, an empty spacer column between blocks.
// Each tool keeps its own columns and its own positions -- nothing is merged
// or averaged across tools. An individual report is the same sheet with one
// block. With competitors fetched, a second "Competitors" sheet puts the
// client's Semrush keywords and 3 competitors' side by side (position, landing
// page, traffic per site; volume, difficulty, intent once per keyword).

export interface ReportBlock {
  source: KeywordSource;
  /** intent: exactly one label per keyword, the same in every block (classifyIntent.ts). */
  rows: (KeywordRow & { intent: string })[];
}

type Column = { header: string; width: number; value: (r: ReportBlock["rows"][number]) => string | number | null };

// Header wording per tool, as in the sample (Semrush: Position / Search Volume; the others: Volume / Current position).
const COLUMNS: Record<KeywordSource, Column[]> = {
  semrush: [
    { header: "Keyword", width: 38, value: (r) => r.keyword },
    { header: "Position", width: 11, value: (r) => r.position },
    { header: "Search Volume", width: 15, value: (r) => r.volume },
    { header: "Intent", width: 15, value: (r) => r.intent },
  ],
  ubersuggest: [
    { header: "Keyword", width: 38, value: (r) => r.keyword },
    { header: "Volume", width: 11, value: (r) => r.volume },
    { header: "Current position", width: 16, value: (r) => r.position },
    { header: "Intent", width: 15, value: (r) => r.intent },
  ],
  ahrefs: [
    { header: "Keywords", width: 38, value: (r) => r.keyword },
    { header: "Volume", width: 11, value: (r) => r.volume },
    { header: "Current position", width: 16, value: (r) => r.position },
    { header: "Intent", width: 15, value: (r) => r.intent },
  ],
};

const SOURCE_ORDER: KeywordSource[] = ["semrush", "ubersuggest", "ahrefs"];
const YELLOW = "FFFFFF00";
const BLUE = "FF4472C4";
const GRID = { style: "thin" as const, color: { argb: "FFD9D9D9" } };
const BORDER = { top: GRID, left: GRID, bottom: GRID, right: GRID };
const SPACER_WIDTH = 6;
// Positions 1-10 (Google's first page) stand out in light green (the team's ask, 2026-10-29).
const TOP_10_FILL = "FFC6EFCE";
const TOP_10_FONT = "FF006100";

/** Light green + bold for a position on Google's first page (1-10). */
export function isFirstPage(position: number | null | undefined): boolean {
  return typeof position === "number" && position >= 1 && position <= 10;
}

function highlightFirstPage(cell: ExcelJS.Cell, position: number | null | undefined) {
  if (!isFirstPage(position)) return;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOP_10_FILL } };
  cell.font = { bold: true, color: { argb: TOP_10_FONT } };
}

/** One site's keywords for the competitor sheet (Semrush Positions export). */
export interface SiteKeywords {
  domain: string;
  rows: KeywordRow[];
}

/** The "Competitors" sheet: the client's keywords + up to 3 competitors' side by side (team's decision, 2026-10-23). */
export interface CompetitorSheet {
  client: SiteKeywords;
  competitors: SiteKeywords[];
  /** The report's one intent per keyword (classifyIntent.ts). */
  intentOf: (keyword: string) => string;
}

/** Each competitor's best keywords (by traffic) the client doesn't rank for -- added below the client's own. */
export const GAP_ROWS_PER_COMPETITOR = 200;

export async function buildDomainReportExcel(blocks: ReportBlock[], competitorSheet?: CompetitorSheet | null): Promise<Buffer> {
  const ordered = SOURCE_ORDER.map((s) => blocks.find((b) => b.source === s)).filter((b): b is ReportBlock => !!b);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Domain Keywords", { views: [{ state: "frozen", ySplit: 2 }] });

  let startCol = 1;
  for (const block of ordered) {
    const columns = COLUMNS[block.source];
    const endCol = startCol + columns.length - 1;

    sheet.mergeCells(1, startCol, 1, endCol);
    const title = sheet.getCell(1, startCol);
    title.value = SOURCE_LABELS[block.source];
    title.font = { bold: true, size: 12 };
    title.alignment = { horizontal: "center", vertical: "middle" };
    for (let c = startCol; c <= endCol; c++) {
      sheet.getCell(1, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };
      sheet.getCell(1, c).border = BORDER;
    }

    columns.forEach((col, i) => {
      const c = startCol + i;
      sheet.getColumn(c).width = col.width;
      const cell = sheet.getCell(2, c);
      cell.value = col.header;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = BORDER;

      const isPosition = /position/i.test(col.header);
      block.rows.forEach((row, r) => {
        const dataCell = sheet.getCell(3 + r, c);
        dataCell.value = col.value(row);
        dataCell.border = BORDER;
        if (i > 0 && col.header !== "Intent") dataCell.alignment = { horizontal: "right" };
        if (isPosition) highlightFirstPage(dataCell, row.position);
      });
    });

    sheet.getColumn(endCol + 1).width = SPACER_WIDTH;
    startCol = endCol + 2;
  }
  sheet.getRow(1).height = 20;
  sheet.getRow(2).height = 18;

  if (competitorSheet && competitorSheet.competitors.length > 0) addCompetitorSheet(workbook, competitorSheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const key = (k: string) => k.trim().toLowerCase().replace(/\s+/g, " ");

/** Rows for the competitor sheet: every client keyword, then each competitor's top gaps by traffic. */
export function competitorSheetRows(data: CompetitorSheet) {
  const sites = [data.client, ...data.competitors];
  const bySite = sites.map((s) => new Map(s.rows.map((r) => [key(r.keyword), r])));
  const clientKeys = [...bySite[0].keys()];
  const gapKeys: string[] = [];
  const taken = new Set(clientKeys);
  // A competitor's own brand searches ("unplugged yoga") aren't gaps the client could win.
  const competitorBrands = data.competitors.flatMap((c) => brandTerms("", c.domain));
  for (const c of data.competitors) {
    const gaps = c.rows.filter((r) => !taken.has(key(r.keyword)) && !matchesBrand(r.keyword, competitorBrands)).sort((a, b) => (b.traffic ?? 0) - (a.traffic ?? 0) || (b.volume ?? 0) - (a.volume ?? 0));
    for (const r of gaps.slice(0, GAP_ROWS_PER_COMPETITOR)) {
      taken.add(key(r.keyword));
      gapKeys.push(key(r.keyword));
    }
  }
  const maxCompetitorTraffic = (k: string) => Math.max(0, ...bySite.slice(1).map((m) => m.get(k)?.traffic ?? 0));
  gapKeys.sort((a, b) => maxCompetitorTraffic(b) - maxCompetitorTraffic(a));
  const rank = (k: string) => bySite[0].get(k)?.position ?? Number.POSITIVE_INFINITY;
  clientKeys.sort((a, b) => rank(a) - rank(b) || (bySite[0].get(b)?.volume ?? 0) - (bySite[0].get(a)?.volume ?? 0));
  return [...clientKeys.map((k) => ({ k, gap: false })), ...gapKeys.map((k) => ({ k, gap: true }))].map(({ k, gap }) => {
    const any = bySite.map((m) => m.get(k)).find((r) => r) as KeywordRow;
    const first = <T>(pick: (r: KeywordRow) => T | null | undefined) => bySite.map((m) => m.get(k)).map((r) => (r ? pick(r) : null)).find((v) => v !== null && v !== undefined) ?? null;
    return {
      keyword: any.keyword,
      volume: first((r) => r.volume),
      difficulty: first((r) => r.difficulty),
      intent: data.intentOf(any.keyword),
      status: gap ? "Gap -- competitors only" : "Client ranks",
      sites: bySite.map((m) => {
        const r = m.get(k);
        return r ? { position: r.position, url: r.url ?? null, traffic: r.traffic ?? null } : null;
      }),
    };
  });
}

const GREEN = "FF70AD47";

function addCompetitorSheet(workbook: ExcelJS.Workbook, data: CompetitorSheet) {
  const sheet = workbook.addWorksheet("Competitors", { views: [{ state: "frozen", ySplit: 2, xSplit: 1 }] });
  const sites = [data.client, ...data.competitors];
  const header = (row: number, col: number, text: string, fill: string, fontColor = "FF000000") => {
    const cell = sheet.getCell(row, col);
    cell.value = text;
    cell.font = { bold: true, color: { argb: fontColor } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = BORDER;
  };

  // Keyword facts (same for every site), then Position / URL / Traffic per site. No "Status" column
  // (the user's call, 2026-10-23): the client's own keywords come first, then the gaps -- blank client
  // columns already show a keyword the client doesn't rank for.
  const facts = [
    { header: "Keyword", width: 38 },
    { header: "Search Volume", width: 13 },
    { header: "Keyword Difficulty", width: 12 },
    { header: "Intent", width: 15 },
  ];
  sheet.mergeCells(1, 1, 1, facts.length);
  for (let c = 1; c <= facts.length; c++) header(1, c, "Keyword", YELLOW);
  facts.forEach((f, i) => {
    sheet.getColumn(i + 1).width = f.width;
    header(2, i + 1, f.header, BLUE, "FFFFFFFF");
  });
  const siteCols = ["Position", "Landing page URL", "Traffic"];
  sites.forEach((site, s) => {
    const start = facts.length + 1 + s * siteCols.length;
    sheet.mergeCells(1, start, 1, start + siteCols.length - 1);
    for (let c = start; c < start + siteCols.length; c++) header(1, c, s === 0 ? `${site.domain} (client)` : site.domain, s === 0 ? GREEN : YELLOW);
    siteCols.forEach((h, i) => {
      sheet.getColumn(start + i).width = i === 1 ? 42 : 10;
      header(2, start + i, h, BLUE, "FFFFFFFF");
    });
  });

  competitorSheetRows(data).forEach((row, r) => {
    const values: (string | number | null)[] = [row.keyword, row.volume, row.difficulty, row.intent];
    for (const site of row.sites) values.push(site?.position ?? null, site?.url ?? null, site?.traffic ?? null);
    values.forEach((v, c) => {
      const cell = sheet.getCell(3 + r, 1 + c);
      cell.value = v;
      cell.border = BORDER;
      if (typeof v === "number") cell.alignment = { horizontal: "right" };
    });
    // Each site's Position column (client's and competitors').
    row.sites.forEach((site, s) => highlightFirstPage(sheet.getCell(3 + r, facts.length + 1 + s * siteCols.length), site?.position));
  });
  sheet.getRow(1).height = 20;
  sheet.getRow(2).height = 30;
}
