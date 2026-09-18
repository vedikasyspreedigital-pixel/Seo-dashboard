import type { RowStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { parseRankingExcel } from "../excel/parser.js";
import { REPORTABLE_RUN_STATUSES, createReportForRun } from "./createReport.js";
import { buildReport } from "./buildReport.js";
import { generateEmailDraft } from "./generateEmailDraft.js";
import { createBaselineFromRows } from "../baselines/createBaselineFromRows.js";

// parser.js is untyped JS (its JSDoc return type is a bare `object[]`) --
// this is the actual row shape it produces (see parseRankingExcel), used
// here to get real property access instead of `object`.
interface ParsedRankingRow {
  rowUid: string;
  keyword: string;
  status: string;
  rankValue: number | null;
  rankDisplay: string | null;
  rankingUrl: string | null;
}

export type ProcessVerifiedExcelUploadResult =
  | { outcome: "SUCCESS"; report: NonNullable<Awaited<ReturnType<typeof prisma.rankingReport.findUnique>>> }
  | { outcome: "RUN_NOT_FOUND" }
  | { outcome: "RUN_NOT_COMPLETED" }
  | { outcome: "DUPLICATE_REPORT"; existingReportId: string }
  | { outcome: "NO_ROWS_PARSED" }
  | { outcome: "UNMATCHED_ROWS"; unmatchedKeywords: string[] };

/**
 * The new workflow's single automatic step: once a manually-verified Excel
 * is uploaded for a completed run, this does everything the spec asks for
 * without any further user action --
 *
 *   apply the verified corrections to this run's rows
 *   -> find the client's previous verified Excel (their latest RankingBaseline)
 *   -> compare (reusing createReportForRun/computeRunAnalytics/compareRunToBaseline,
 *      exactly as-is -- fully deterministic, no AI/Claude anywhere)
 *   -> build the client PDF (buildReport, as-is)
 *   -> draft the email and submit it for approval (generateEmailDraft, as-is)
 *   -> only once ALL of the above succeeded, this verified Excel becomes the
 *      client's new baseline (createBaselineFromRows) -- never overwriting
 *      the previous one, never promoted to baseline on a failed run.
 *
 * The verified Excel must be the SAME template the run's own "Download
 * Excel" export produces -- parseRankingExcel computes the identical rowUid
 * used at original ingest, so a row's identity (keyword/targetUrl/location/
 * language/seDomain) survives the round trip; only status/rank/rankingUrl
 * are expected to change.
 */
export async function processVerifiedExcelUpload(
  runId: string,
  fileBuffer: Buffer,
  sourceFilename: string,
  createdBy: string | null,
): Promise<ProcessVerifiedExcelUploadResult> {
  const run = await prisma.rankingRun.findUnique({ where: { id: runId } });
  if (!run) return { outcome: "RUN_NOT_FOUND" };
  if (!REPORTABLE_RUN_STATUSES.includes(run.status)) return { outcome: "RUN_NOT_COMPLETED" };

  // Checked here, before any row mutation, not left for createReportForRun's
  // own (later) duplicate check -- otherwise a re-upload against a run that
  // already has a report would still overwrite that run's stored rank/status
  // data via the updateMany below, even though no new report/baseline is
  // ever produced from it.
  const existingReport = await prisma.rankingReport.findFirst({ where: { runId } });
  if (existingReport) return { outcome: "DUPLICATE_REPORT", existingReportId: existingReport.id };

  const { rows: parsedRowsRaw } = await parseRankingExcel(fileBuffer, { clientId: run.clientId });
  const parsedRows = parsedRowsRaw as unknown as ParsedRankingRow[];
  if (parsedRows.length === 0) return { outcome: "NO_ROWS_PARSED" };

  const existingRows = await prisma.rankingRow.findMany({ where: { runId }, select: { rowUid: true } });
  const existingRowUids = new Set(existingRows.map((r) => r.rowUid));
  const unmatched = parsedRows.filter((row) => !existingRowUids.has(row.rowUid));
  if (unmatched.length > 0) {
    // Protects against uploading the wrong file (a different run's export,
    // or one where the identifying columns were hand-edited) -- applying
    // only the rows that DO match would silently accept a partially wrong
    // file, so this rejects the whole upload instead.
    return { outcome: "UNMATCHED_ROWS", unmatchedKeywords: unmatched.map((row) => row.keyword) };
  }

  const latestBaseline = await prisma.rankingBaseline.findFirst({
    where: { clientId: run.clientId },
    orderBy: { createdAt: "desc" },
  });

  await Promise.all(
    parsedRows.map((row) =>
      prisma.rankingRow.updateMany({
        where: { runId, rowUid: row.rowUid },
        data: {
          status: row.status as RowStatus,
          rankValue: row.rankValue,
          rankDisplay: row.rankDisplay,
          rankingUrl: row.rankingUrl,
        },
      }),
    ),
  );

  const created = await createReportForRun(runId, undefined, latestBaseline?.id, { skipRunFallback: true });
  if (created.outcome !== "SUCCESS") return created;

  await buildReport(created.report.id);
  await generateEmailDraft(created.report.id);

  await createBaselineFromRows(run.clientId, {
    sourceFilename,
    sourceType: "EXCEL",
    baselineDate: run.completedAt ?? run.createdAt,
    createdBy,
    rows: parsedRows.map((row) => ({ keyword: row.keyword, rankValue: row.rankValue, rankDisplay: row.rankDisplay })),
  });

  const finalReport = await prisma.rankingReport.findUniqueOrThrow({ where: { id: created.report.id } });
  return { outcome: "SUCCESS", report: finalReport };
}
