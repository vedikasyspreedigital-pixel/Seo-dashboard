import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { prisma } from "../db/client.js";
import { exportRankingExcel } from "./exporter.js";
import { locateColumns } from "./mapping.js";
import { normalizeKeyword } from "../baselines/normalizeKeyword.js";
import { selectPreviousBaseline } from "../baselines/selectPreviousBaseline.js";
import { formatOrdinalDate } from "../reporting/formatOrdinalDate.js";

// The "Download Excel" file for a run (backend/api/routes/runs.ts): the
// original upload re-patched with the current row state.
export async function exportRunExcelBuffer(runId: string): Promise<{ buffer: Buffer; filename: string }> {
  const run = await prisma.rankingRun.findUniqueOrThrow({ where: { id: runId }, include: { client: { include: { workspace: { select: { slug: true } } } } } });
  const rows = await prisma.rankingRow.findMany({ where: { runId }, orderBy: { sourceRowNumber: "asc" } });
  const originalBuffer = await readFile(run.sourceFilePath);
  let buffer = (await exportRankingExcel(
    originalBuffer,
    rows.map((r) => ({
      sourceRowNumber: r.sourceRowNumber,
      status: r.status,
      rankDisplay: r.rankDisplay,
      rankingUrl: r.rankingUrl,
    })),
  )) as Buffer;

  if (PREVIOUS_COLUMN_WORKSPACES.has(run.client.workspace?.slug ?? "")) {
    buffer = await addPreviousAndChangeColumns(buffer, run, rows);
  }
  return { buffer, filename: run.sourceFilename };
}

/** Workspaces whose downloaded run Excel shows the last baseline next to the new ranks (2026-10-16). */
const PREVIOUS_COLUMN_WORKSPACES = new Set(["advanced-seo"]);

const PREVIOUS_HEADER_PREFIX = "Previous (";
const CHANGE_HEADER = "Change";

/** Same wording as the client PDF's movement column (generateClientReportPdf.ts). `previous` undefined = keyword not in the baseline. */
export function changeLabel(previous: { rankValue: number | null } | undefined, currentRank: number | null): string {
  if (!previous) return currentRank !== null ? "↑ New" : "-";
  const prev = previous.rankValue;
  if (prev === null && currentRank === null) return "-";
  if (prev === null) return "↑ New";
  if (currentRank === null) return "↓ Lost";
  const delta = prev - currentRank; // lower rank number is better
  if (delta > 0) return `↑ +${delta}`;
  if (delta < 0) return `↓ ${delta}`;
  return "→ 0";
}

/**
 * Advanced SEO: inserts "Previous (<baseline date>)" right BEFORE "Ranks" and
 * "Change" right AFTER it, so the team verifies the new ranks next to the
 * ones they'll be compared with. The previous ranks come from the baseline
 * the report compares against -- the report's pinned one if it already
 * exists, else the one its first verified upload will pick. Display only:
 * the comparison always uses the saved baseline, never these cells (the
 * verified-Excel reader finds columns by header name, so they're ignored).
 * A file that already has the columns (a re-downloaded verified Excel) gets
 * them refreshed, not duplicated. No baseline yet -> the Excel is unchanged.
 */
async function addPreviousAndChangeColumns(
  buffer: Buffer,
  run: { id: string; clientId: string; completedAt: Date | null; createdAt: Date },
  rows: { sourceRowNumber: number; keyword: string; rankValue: number | null }[],
): Promise<Buffer> {
  const report = await prisma.rankingReport.findFirst({ where: { runId: run.id }, orderBy: { createdAt: "desc" }, select: { previousBaselineId: true } });
  const baselineId = report?.previousBaselineId ?? (await selectPreviousBaseline(run))?.id;
  if (!baselineId) return buffer;
  const baseline = await prisma.rankingBaseline.findUniqueOrThrow({
    where: { id: baselineId },
    select: { baselineDate: true, rows: { select: { normalizedKeyword: true, rankValue: true, rankDisplay: true } } },
  });
  const previousByKeyword = new Map<string, { rankValue: number | null; rankDisplay: string | null }>();
  for (const r of baseline.rows) if (!previousByKeyword.has(r.normalizedKeyword)) previousByKeyword.set(r.normalizedKeyword, r);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  const header = sheet.getRow(1);

  let ranksCol = (locateColumns(header) as { rank: number }).rank;
  let previousCol = 0;
  let changeCol = 0;
  header.eachCell({ includeEmpty: false }, (cell, col) => {
    const text = String(cell.value ?? "").trim();
    if (text.startsWith(PREVIOUS_HEADER_PREFIX)) previousCol = col;
    if (text === CHANGE_HEADER) changeCol = col;
  });

  if (!previousCol) {
    sheet.spliceColumns(ranksCol, 0, []);
    previousCol = ranksCol;
    ranksCol += 1;
    if (changeCol >= previousCol) changeCol += 1;
  }
  if (!changeCol) {
    sheet.spliceColumns(ranksCol + 1, 0, []);
    changeCol = ranksCol + 1;
  }

  // New header cells look like the Ranks header.
  const ranksHeaderStyle = { ...header.getCell(ranksCol).style };
  header.getCell(previousCol).value = `${PREVIOUS_HEADER_PREFIX}${formatOrdinalDate(baseline.baselineDate)})`;
  header.getCell(previousCol).style = ranksHeaderStyle;
  header.getCell(changeCol).value = CHANGE_HEADER;
  header.getCell(changeCol).style = ranksHeaderStyle;
  header.commit();

  for (const r of rows) {
    const row = sheet.getRow(r.sourceRowNumber);
    const style = { ...row.getCell(ranksCol).style };
    const previous = previousByKeyword.get(normalizeKeyword(r.keyword));
    const prevCell = row.getCell(previousCol);
    prevCell.value = previous ? (previous.rankValue ?? previous.rankDisplay ?? "-") : "-";
    prevCell.style = style;
    const changeCell = row.getCell(changeCol);
    changeCell.value = changeLabel(previous, r.rankValue);
    changeCell.style = style;
    row.commit();
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
