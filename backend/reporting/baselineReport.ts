import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { normalizeKeyword } from "../baselines/normalizeKeyword.js";
import { normalizeMatchDomain } from "../dataforseo/buildRequest.js";
import {
  brandWordsOf,
  competitionLabel,
  formatIndianResults,
  guessIntent,
  serpSummary,
  volumeBucket,
  wordSetKey,
  type OrganicItem,
} from "./baselineColumns.js";
import { countryOfSeDomain, googleAdsConfigured } from "./keywordPlanner.js";

/**
 * "Baseline Report" (2026-11-10): the first report a NEW client gets -- the team's "Client Keyword Baseline
 * Report" Excel (Venezia Designs / Altered Images layout), sent INSTEAD of the PDF when the team picks it on a
 * report (attachmentSource "baseline"). Grey title row with the logo, the greeting letter signed Caahill
 * Murzello, then one row per keyword:
 *   Keywords | Avg. Monthly Searches | Competition | Number of Result | SERP result | Intent | <date> ranking
 * sorted by rank, "Not in 100" last. Ranks, result counts, SERP mix and intent come from the run itself;
 * volume/competition from Keyword Planner (KeywordMetric). Once sent, the run's ranks become the client's
 * baseline as for every sent report.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO = readFileSync(path.join(__dirname, "assets/baseline-report-logo.png"));

export const BASELINE_LETTER =
  "Dear Client,\n\nGreetings from SySpree!\n\nPlease find attached the below Keyword Baseline Report for your website. We shall continue to share similar reports that will include updates and ranking status, with you on a regular basis in the future too.\n\nPlease feel free to reach out to us in case you have any queries or if you want us to walk you through the details. And, we look forward to your feedback to ensure that you have a quality experience with SySpree.\n\nThanks & Regards, \nCaahill Murzello.";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "09th Nov 2026" -- the team's title/column date style. */
export function baselineDateLabel(date: Date): string {
  const day = date.getUTCDate();
  const suffix = day >= 11 && day <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${String(day).padStart(2, "0")}${suffix} ${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export interface BaselineRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
  volume: string | number | null;
  competition: string | null;
  results: string | null;
  serp: string | null;
  intent: string | null;
}

const THIN = { style: "thin" as const, color: { argb: "FF000000" } };
const BOX = { left: THIN, right: THIN, top: THIN, bottom: THIN };
const HEADERS = ["Keywords", "Avg. Monthly Searches", "Competition", "Number of Result", "SERP result", "Intent"];
const WIDTHS = [34, 16, 14, 22, 44, 15, 18];

function rankCell(row: BaselineRow): string | number {
  if (row.rankValue !== null && row.rankValue !== undefined) return row.rankValue;
  const d = row.rankDisplay?.trim();
  return d && !/^\d+$/.test(d) ? d : "Not in 100";
}

/** Ranked keywords first (by rank), then the rest in the run's order. */
export function sortBaselineRows(rows: BaselineRow[]): BaselineRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.rankValue ?? Number.POSITIVE_INFINITY) - (b.r.rankValue ?? Number.POSITIVE_INFINITY) || a.i - b.i)
    .map((x) => x.r);
}

export async function buildBaselineWorkbook(input: { domain: string; reportDate: Date; rows: BaselineRow[] }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("Sheet1", { views: [{ state: "frozen", ySplit: 3 }] });
  const dateLabel = baselineDateLabel(input.reportDate);
  const lastCol = HEADERS.length + 1;
  WIDTHS.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  // Row 1: grey title, right-aligned, with the logo top-left.
  ws.mergeCells(1, 1, 1, lastCol);
  const title = ws.getCell(1, 1);
  title.value = `Client Keyword Baseline Report\n${input.domain} \n${dateLabel}`;
  title.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" }, name: "Calibri", family: 2 };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF808080" } };
  title.alignment = { horizontal: "right", vertical: "top", wrapText: true };
  title.border = BOX;
  ws.getRow(1).height = 54;
  const logoId = workbook.addImage({ buffer: LOGO as unknown as ExcelJS.Buffer, extension: "png" });
  ws.addImage(logoId, { tl: { col: 0.05, row: 0.08 }, ext: { width: 104, height: 42 }, editAs: "oneCell" });

  // Row 2: the letter.
  ws.mergeCells(2, 1, 2, lastCol);
  const letter = ws.getCell(2, 1);
  letter.value = BASELINE_LETTER;
  letter.font = { size: 11, name: "Calibri", family: 1 };
  letter.alignment = { horizontal: "left", vertical: "top", wrapText: true };
  letter.border = BOX;
  ws.getRow(2).height = 150;

  // Row 3: orange headers.
  const header = ws.getRow(3);
  [...HEADERS, `${dateLabel} ranking`].forEach((h, i) => {
    const cell = header.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" }, name: "Calibri", family: 2 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF6600" } };
    cell.border = BOX;
    cell.alignment = { horizontal: i === 0 ? "left" : "center", vertical: "middle", wrapText: true };
  });
  header.height = 33;

  sortBaselineRows(input.rows).forEach((row, i) => {
    const r = ws.getRow(4 + i);
    const values: (string | number | null)[] = [row.keyword, row.volume, row.competition, row.results, row.serp, row.intent, rankCell(row)];
    values.forEach((v, c) => {
      const cell = r.getCell(c + 1);
      cell.value = v ?? "";
      cell.font = { size: 11, color: { argb: "FF000000" }, name: "Calibri", family: 2 };
      cell.border = BOX;
      cell.alignment = { horizontal: c === 0 || c === 4 ? "left" : "center", vertical: "middle", wrapText: c === 4 };
    });
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function baselineFilename(clientName: string): string {
  return `${clientName.replace(/[\\/:*?"<>|]/g, "").trim()} - Baseline Report.xlsx`;
}

export class BaselineReportUnavailableError extends Error {}

interface SerpRow {
  ranking_row_id: string;
  results: string | null;
  top10: OrganicItem[] | null;
}

export interface BaselineBuild {
  buffer: Buffer;
  filename: string;
  keywordCount: number;
  dateLabel: string;
  country: string | null;
  /** Keywords with no Keyword Planner numbers yet (written as "0 – 10" / "Unknown" if sent like this). */
  missingVolumes: string[];
  /** Keywords matched to a merged Keyword Planner keyword (same words, other order). */
  merged: { keyword: string; usedFiguresOf: string }[];
  /** Keywords whose saved search answer is gone or empty (no Number of Result / SERP result). */
  missingSerp: string[];
  metricsSource: string | null;
  googleAdsAvailable: boolean;
}

/** The Baseline Report for a report: its run's ranks + saved DataForSEO answers + the client's Keyword Planner numbers. */
export async function buildBaselineForReport(reportId: string): Promise<BaselineBuild> {
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId }, include: { client: true, run: true } });
  const rows = await prisma.rankingRow.findMany({
    where: { runId: report.runId },
    orderBy: { sourceRowNumber: "asc" },
    select: { id: true, keyword: true, rankValue: true, rankDisplay: true, fullUrl: true, targetUrl: true, seDomain: true },
  });
  if (rows.length === 0) throw new BaselineReportUnavailableError("This report's run has no keywords.");

  // Per keyword, the newest saved answer that has results: Google's result count and the top 10 organic results.
  // Only those few fields are read out, in the database -- a run's raw answers can be many MB.
  const serp = await prisma.$queryRaw<SerpRow[]>`
    SELECT DISTINCT ON (a.ranking_row_id) a.ranking_row_id,
           (a.raw_response->'tasks'->0->'result'->0->>'se_results_count') AS results,
           (SELECT jsonb_agg(x.i ORDER BY (x.i->>'rank_group')::int)
              FROM (SELECT i FROM jsonb_array_elements(COALESCE(a.raw_response->'tasks'->0->'result'->0->'items', '[]'::jsonb)) i
                     WHERE i->>'type' = 'organic'
                     ORDER BY (i->>'rank_group')::int
                     LIMIT 10) x) AS top10
    FROM ranking_row_attempts a
    JOIN ranking_rows r ON r.id = a.ranking_row_id
    WHERE r.run_id = ${report.runId} AND a.raw_response IS NOT NULL
    ORDER BY a.ranking_row_id,
             (jsonb_typeof(a.raw_response->'tasks'->0->'result'->0->'items') = 'array') DESC NULLS LAST,
             a.created_at DESC`;
  const serpByRow = new Map(serp.map((s) => [s.ranking_row_id, s]));

  const metrics = await prisma.keywordMetric.findMany({ where: { clientId: report.clientId } });
  const byKey = new Map(metrics.map((m) => [m.normalizedKeyword, m]));
  const byWords = new Map<string, (typeof metrics)[number]>();
  for (const m of metrics) if (!byWords.has(wordSetKey(m.keyword))) byWords.set(wordSetKey(m.keyword), m);

  const domain =
    report.client.domain?.trim() ||
    rows.map((r) => normalizeMatchDomain(r.fullUrl) ?? normalizeMatchDomain(String(r.targetUrl ?? "").replace(/\*/g, "").replace(/^\.+|\.+$/g, ""))).find(Boolean) ||
    report.client.name;
  const brandWords = brandWordsOf(domain);

  const missingVolumes: string[] = [];
  const missingSerp: string[] = [];
  const merged: BaselineBuild["merged"] = [];
  const sources = new Set<string>();
  const built: BaselineRow[] = rows.map((row) => {
    let metric = byKey.get(normalizeKeyword(row.keyword));
    if (!metric) {
      metric = byWords.get(wordSetKey(row.keyword));
      if (metric) merged.push({ keyword: row.keyword, usedFiguresOf: metric.keyword });
    }
    if (metric) sources.add(metric.source);
    else missingVolumes.push(row.keyword);
    const s = serpByRow.get(row.id);
    const top10 = Array.isArray(s?.top10) ? s!.top10 : [];
    const summary = serpSummary(top10);
    const results = formatIndianResults(s?.results != null ? Number(s.results) : null);
    if (!summary || !results) missingSerp.push(row.keyword);
    return {
      keyword: row.keyword,
      rankValue: row.rankValue,
      rankDisplay: row.rankDisplay,
      volume: volumeBucket(metric?.avgMonthlySearches ?? null),
      competition: competitionLabel(metric?.competition ?? null),
      results,
      serp: summary?.text ?? null,
      intent: guessIntent(row.keyword, summary?.categories ?? null, brandWords),
    };
  });

  const reportDate = report.reportDate ?? report.run.completedAt ?? report.run.createdAt;
  const buffer = await buildBaselineWorkbook({ domain, reportDate, rows: built });
  return {
    buffer,
    filename: baselineFilename(report.client.name),
    keywordCount: built.length,
    dateLabel: baselineDateLabel(reportDate),
    country: countryOfSeDomain(rows[0]?.seDomain),
    missingVolumes,
    merged,
    missingSerp,
    metricsSource: sources.size ? [...sources].join(", ") : null,
    googleAdsAvailable: googleAdsConfigured(),
  };
}

/** Saves Keyword Planner numbers for a client's keywords (replacing older numbers for the same keywords). */
export async function saveKeywordMetrics(clientId: string, metrics: { keyword: string; avgMonthlySearches: string | null; competition: string | null }[], source: string, by: string | null) {
  const seen = new Set<string>();
  let saved = 0;
  for (const m of metrics) {
    const key = normalizeKeyword(m.keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const data = { keyword: m.keyword.trim(), avgMonthlySearches: m.avgMonthlySearches, competition: m.competition, source, updatedBy: by };
    await prisma.keywordMetric.upsert({ where: { clientId_normalizedKeyword: { clientId, normalizedKeyword: key } }, create: { clientId, normalizedKeyword: key, ...data }, update: data });
    saved++;
  }
  return saved;
}
