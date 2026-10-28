import type { Prisma, RankingReport, RankingRun, RowStatus } from "@prisma/client";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { parseRankingExcel } from "../excel/parser.js";
import { REPORTABLE_RUN_STATUSES, createReportForRun } from "./createReport.js";
import { buildReport } from "./buildReport.js";
import { generateEmailDraft, resendSubjectSuffix } from "./generateEmailDraft.js";
import { computeRunAnalytics } from "./computeRunAnalytics.js";
import { compareRunToBaseline } from "../baselines/compareRunToBaseline.js";
import { upsertRunBaseline } from "../baselines/createBaselineFromRows.js";
import { selectPreviousBaseline } from "../baselines/selectPreviousBaseline.js";
import { REGENERABLE_REPORT_STATUSES, resetReportForRegeneration } from "./reportTransitions.js";
import { InvalidReportTransitionError } from "./errors.js";

// parser.js is untyped JS (its JSDoc return type is a bare `object[]`) --
// this is the actual row shape it produces (see parseRankingExcel), used
// here to get real property access instead of `object`.
interface ParsedRankingRow {
  sourceRowNumber: number;
  rowUid: string;
  keyword: string;
  status: string;
  rankValue: number | null;
  rankDisplay: string | null;
  rankingUrl: string | null;
}

type FullReport = RankingReport;

export type ReportLockReason = "SENDING" | "REJECTED";

/** Why a run's report can't be (re)generated right now -- shared by the upload and the Regenerate button. */
export type RegenerationBlock =
  | { outcome: "REPORT_LOCKED"; reason: ReportLockReason; existingReportId: string }
  // A SENT report can be corrected and sent again, but only after the user
  // explicitly confirms -- nothing is written until they do.
  | { outcome: "RESEND_CONFIRMATION_REQUIRED"; existingReportId: string; sendCount: number; lastSentAt: Date | null }
  | { outcome: "BASELINE_IN_USE"; laterReportId: string };

export interface ReportGenerationSuccess {
  outcome: "SUCCESS";
  report: FullReport;
  /** false on the run's first upload; true when an existing report was rebuilt in place. */
  regenerated: boolean;
  /** Rows whose status/rank/URL differ from what the run held before this upload; null for a Regenerate without a file. */
  rowsChanged: number | null;
  /** What this report compares against, so the UI can say so plainly. */
  previousBaseline: { id: string; baselineDate: Date; sourceFilename: string } | null;
}

export type ProcessVerifiedExcelUploadResult =
  | ReportGenerationSuccess
  | RegenerationBlock
  | { outcome: "RUN_NOT_FOUND" }
  | { outcome: "RUN_NOT_COMPLETED" }
  | { outcome: "DUPLICATE_REPORT"; existingReportId: string }
  | { outcome: "NO_ROWS_PARSED" }
  | { outcome: "UNMATCHED_ROWS"; unmatchedKeywords: string[] }
  | { outcome: "INVALID_ROWS"; problems: string[] };

/**
 * Why rows of a verified Excel can't be used, one line each (row number, keyword, reason): rows the parser
 * couldn't read (a wrong Status, an empty required cell), ranks that aren't a position 1-100 (a 0 even
 * counted as top 3), and the same keyword twice (whichever saved last won).
 */
export function verifiedRowProblems(rows: ParsedRankingRow[], rowErrors: { sourceRowNumber: number; reason: string }[]): string[] {
  const problems = rowErrors.map((e) => `Row ${e.sourceRowNumber}: ${e.reason}`);
  const firstRowOf = new Map<string, number>();
  for (const row of rows) {
    if (row.rankValue !== null && !(row.rankValue >= 1 && row.rankValue <= 100)) {
      problems.push(`Row ${row.sourceRowNumber} ("${row.keyword}"): rank ${row.rankValue} -- must be 1 to 100, "Not in 100", or empty`);
    }
    const first = firstRowOf.get(row.rowUid);
    if (first !== undefined) problems.push(`Row ${row.sourceRowNumber} ("${row.keyword}"): this keyword is already on row ${first}`);
    else firstRowOf.set(row.rowUid, row.sourceRowNumber);
  }
  return problems;
}

export type RegenerateReportResult =
  | ReportGenerationSuccess
  | RegenerationBlock
  | { outcome: "REPORT_NOT_FOUND" }
  | { outcome: "RUN_NOT_FOUND" }
  | { outcome: "RUN_NOT_COMPLETED" }
  | { outcome: "DUPLICATE_REPORT"; existingReportId: string };

/**
 * The verified-Excel step, repeatable until the report is sent:
 *
 *   apply the verified corrections to this run's rows
 *   -> first upload only: pick the previous baseline (latest RANKING date
 *      before this run -- see selectPreviousBaseline) and pin it on the report
 *   -> compare against that pinned baseline (deterministic)
 *   -> build the client PDF, dated today (buildReport)
 *   -> draft the email and submit it for approval (generateEmailDraft)
 *
 *   previous verified baseline -> this run -> regenerate as often as needed
 *   -> Approve & Send -> ONLY THEN do these ranks become the client's new
 *   baseline (promoteSentReportToBaseline, called by approveAndSend.ts)
 *
 * First upload for a run creates the report. Any later upload (same file or
 * an updated one) rebuilds that SAME report in place. A report being sent is
 * locked; an already-SENT report can be reopened only with confirmResend
 * (the user confirmed it will email the client again) -- without it,
 * nothing is written. Every check runs
 * before anything is written, so a refused upload never touches the run.
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
  options: { confirmResend?: boolean } = {},
): Promise<ProcessVerifiedExcelUploadResult> {
  const run = await prisma.rankingRun.findUnique({ where: { id: runId } });
  if (!run) return { outcome: "RUN_NOT_FOUND" };
  if (!REPORTABLE_RUN_STATUSES.includes(run.status)) return { outcome: "RUN_NOT_COMPLETED" };

  const existingReport = await prisma.rankingReport.findFirst({ where: { runId }, orderBy: { createdAt: "desc" } });
  if (existingReport) {
    const block = await findRegenerationBlock(existingReport, run.id, options.confirmResend === true);
    if (block) return block;
  }

  const { rows: parsedRowsRaw, rowErrors } = await parseRankingExcel(fileBuffer, { clientId: run.clientId });
  const parsedRows = parsedRowsRaw as unknown as ParsedRankingRow[];
  // Rows that can't be used are refused, not skipped: a skipped row silently kept its old rank in the
  // client's report (audit 2026-10-27). Nothing is written when any row has a problem.
  const problems = verifiedRowProblems(parsedRows, rowErrors as { sourceRowNumber: number; reason: string }[]);
  if (problems.length > 0) return { outcome: "INVALID_ROWS", problems };
  if (parsedRows.length === 0) return { outcome: "NO_ROWS_PARSED" };

  const existingRows = await prisma.rankingRow.findMany({
    where: { runId },
    select: { rowUid: true, status: true, rankValue: true, rankDisplay: true, rankingUrl: true },
  });
  const existingByUid = new Map(existingRows.map((r) => [r.rowUid, r]));
  const unmatched = parsedRows.filter((row) => !existingByUid.has(row.rowUid));
  if (unmatched.length > 0) {
    // Protects against uploading the wrong file (a different run's export,
    // or one where the identifying columns were hand-edited) -- applying
    // only the rows that DO match would silently accept a partially wrong
    // file, so this rejects the whole upload instead.
    return { outcome: "UNMATCHED_ROWS", unmatchedKeywords: unmatched.map((row) => row.keyword) };
  }

  const rowsChanged = parsedRows.filter((row) => {
    const before = existingByUid.get(row.rowUid)!;
    return (
      before.status !== row.status ||
      before.rankValue !== row.rankValue ||
      (before.rankDisplay ?? null) !== (row.rankDisplay ?? null) ||
      (before.rankingUrl ?? null) !== (row.rankingUrl ?? null)
    );
  }).length;

  // All rows or none (a failure halfway used to leave the run partly updated) -- and the report is claimed
  // in the SAME step: taken out of "Approved" before any rank changes, so a send can't start in between.
  // A send that slipped in after the check above used to send the OLD PDF while the client's new baseline
  // was then saved from the NEW ranks (audit 2026-10-27). If it's already being sent, nothing is written.
  const claimable = options.confirmResend ? [...REGENERABLE_REPORT_STATUSES, ReportStatus.SENT] : REGENERABLE_REPORT_STATUSES;
  const claimed = await prisma.$transaction(
    async (tx) => {
      if (existingReport) {
        const { count } = await tx.rankingReport.updateMany({
          where: { id: existingReport.id, status: { in: claimable } },
          data: { status: ReportStatus.PENDING_ANALYSIS, approvedBy: null, approvedAt: null },
        });
        if (count === 0) return false;
      }
      for (const row of parsedRows) {
        await tx.rankingRow.updateMany({
          where: { runId, rowUid: row.rowUid },
          data: { status: row.status as RowStatus, rankValue: row.rankValue, rankDisplay: row.rankDisplay, rankingUrl: row.rankingUrl },
        });
      }
      return true;
    },
    { timeout: 60_000 },
  );
  if (!claimed) return { outcome: "REPORT_LOCKED", reason: "SENDING", existingReportId: existingReport!.id };

  return generateReportForRun(run, existingReport, { verifiedFilename: sourceFilename, rowsChanged });
}

/**
 * The Regenerate button: rebuild an existing report from the run's current
 * (already verified) rows, with no new file -- e.g. to re-date it. Same
 * locks, same pinned comparison, same pipeline as a re-upload.
 */
export async function regenerateReport(
  reportId: string,
  _createdBy: string | null,
  options: { confirmResend?: boolean } = {},
): Promise<RegenerateReportResult> {
  const report = await prisma.rankingReport.findUnique({ where: { id: reportId } });
  if (!report) return { outcome: "REPORT_NOT_FOUND" };
  const run = await prisma.rankingRun.findUniqueOrThrow({ where: { id: report.runId } });
  if (!REPORTABLE_RUN_STATUSES.includes(run.status)) return { outcome: "RUN_NOT_COMPLETED" };

  const block = await findRegenerationBlock(report, run.id, options.confirmResend === true);
  if (block) return block;

  return generateReportForRun(run, report, { verifiedFilename: null, rowsChanged: null });
}

/**
 * Called once, right after a report is successfully SENT (approveAndSend.ts):
 * the ranks the client just received become the client's newest baseline,
 * dated the same day as the PDF they received. This is the ONLY place a
 * verified run turns into a baseline -- uploading, re-uploading and
 * regenerating never create or change one, so nothing is ever compared
 * against a report that hasn't actually gone out.
 *
 * Replaces the run's own baseline in place if one already exists (a report
 * whose baseline was created under the old generate-time rule), so a run
 * still has exactly one. Reports from the old manual "Generate Report"
 * wizard never produced a baseline and still don't.
 */
export async function promoteSentReportToBaseline(reportId: string, createdBy: string | null) {
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId }, include: { run: true } });
  if (report.status !== ReportStatus.SENT) return null;

  const existingOwn = await prisma.rankingBaseline.findFirst({ where: { sourceRunId: report.runId }, orderBy: { createdAt: "desc" } });
  if (!report.verifiedFilename && !existingOwn) return null; // not a verified-Excel report

  const rows = await prisma.rankingRow.findMany({
    where: { runId: report.runId },
    select: { keyword: true, rankValue: true, rankDisplay: true },
  });
  return upsertRunBaseline(report.clientId, report.runId, {
    sourceFilename: report.verifiedFilename ?? existingOwn?.sourceFilename ?? report.run.sourceFilename,
    sourceType: "EXCEL",
    baselineDate: report.reportDate ?? existingOwn?.baselineDate ?? report.run.completedAt ?? report.run.createdAt,
    createdBy,
    rows,
  });
}

/**
 * A sent verified report whose baseline save failed (approveAndSend only logs that) was never noticed --
 * the next report silently compared against an older baseline (audit 2026-10-27). This finds every such
 * report and saves its baseline now; safe to repeat (promoteSentReportToBaseline replaces, never adds).
 * Run at server start and every hour.
 */
export async function promoteMissingBaselines(): Promise<number> {
  const missing = await prisma.rankingReport.findMany({
    where: { status: ReportStatus.SENT, verifiedFilename: { not: null }, run: { producedBaselines: { none: {} } } },
    select: { id: true, approvedBy: true },
  });
  let saved = 0;
  for (const r of missing) {
    const ok = await promoteSentReportToBaseline(r.id, r.approvedBy).then(
      (b) => !!b,
      (err) => (console.error(`[reports] saving the baseline of sent report ${r.id} failed again:`, err), false),
    );
    if (ok) saved++;
  }
  if (saved > 0) console.warn(`[reports] saved the missing baseline of ${saved} sent report(s)`);
  return saved;
}

async function findRegenerationBlock(report: FullReport, runId: string, confirmResend: boolean): Promise<RegenerationBlock | null> {
  if (report.status === ReportStatus.SENDING) return { outcome: "REPORT_LOCKED", reason: "SENDING", existingReportId: report.id };
  if (report.status !== ReportStatus.SENT && !REGENERABLE_REPORT_STATUSES.includes(report.status)) {
    return { outcome: "REPORT_LOCKED", reason: "REJECTED", existingReportId: report.id };
  }

  // A later report that already compared against THIS run's baseline would
  // silently stop matching what it shows if this run's data changed now.
  const ownBaseline = await prisma.rankingBaseline.findFirst({ where: { sourceRunId: runId }, select: { id: true } });
  if (ownBaseline) {
    const laterReport = await prisma.rankingReport.findFirst({
      where: { previousBaselineId: ownBaseline.id, id: { not: report.id } },
      select: { id: true },
    });
    if (laterReport) return { outcome: "BASELINE_IN_USE", laterReportId: laterReport.id };
  }

  // Checked last, so a report that can't be changed at all (above) never
  // asks for a confirmation it would then refuse anyway.
  if (report.status === ReportStatus.SENT && !confirmResend) {
    const sendCount = await prisma.reportSend.count({ where: { reportId: report.id } });
    return { outcome: "RESEND_CONFIRMATION_REQUIRED", existingReportId: report.id, sendCount: Math.max(sendCount, 1), lastSentAt: report.sentAt };
  }
  return null;
}

async function generateReportForRun(
  run: RankingRun,
  existingReport: FullReport | null,
  { verifiedFilename, rowsChanged }: { verifiedFilename: string | null; rowsChanged: number | null },
): Promise<
  | ReportGenerationSuccess
  | { outcome: "DUPLICATE_REPORT"; existingReportId: string }
  | { outcome: "RUN_NOT_FOUND" }
  | { outcome: "RUN_NOT_COMPLETED" }
  | Extract<RegenerationBlock, { outcome: "REPORT_LOCKED" }>
> {
  // The comparison source is chosen ONCE, on the run's first upload, and then
  // pinned on the report: every later re-upload/regenerate compares against
  // exactly the same baseline (or the same prior run, for an old wizard
  // report), whatever else gets uploaded in the meantime.
  let reportId: string;
  let previousBaselineId: string | null;
  if (!existingReport) {
    const selected = await selectPreviousBaseline(run);
    const created = await createReportForRun(run.id, undefined, selected?.id, { skipRunFallback: true });
    if (created.outcome !== "SUCCESS") return created;
    reportId = created.report.id;
    previousBaselineId = created.report.previousBaselineId;
  } else {
    previousBaselineId = existingReport.previousBaselineId;
    const analytics = previousBaselineId
      ? await compareRunToBaseline(run.id, previousBaselineId)
      : await computeRunAnalytics(run.id, existingReport.previousRunId ?? undefined);
    try {
      await resetReportForRegeneration(existingReport.id, {
        analyticsJson: analytics as unknown as Prisma.InputJsonValue,
        previousBaselineId,
        previousRunId: existingReport.previousRunId,
      });
    } catch (err) {
      // The report started sending after the check above: the same "locked" answer, not a 500 (audit 2026-10-27).
      if (err instanceof InvalidReportTransitionError) return { outcome: "REPORT_LOCKED", reason: "SENDING", existingReportId: existingReport.id };
      throw err;
    }
    reportId = existingReport.id;
  }
  if (verifiedFilename) {
    await prisma.rankingReport.update({ where: { id: reportId }, data: { verifiedFilename } });
  }

  await buildReport(reportId);
  // A report that has already gone out gets "(Updated)" -- "(Updated 2)" on
  // the next correction, and so on -- so the client sees it's a correction,
  // and ClickUp's same-subject duplicate guard still protects every send.
  await generateEmailDraft(reportId, {
    ...(existingReport && Array.isArray(existingReport.resolvedRecipients)
      ? {
          keepRecipients: {
            recipients: existingReport.resolvedRecipients as string[],
            cc: Array.isArray(existingReport.resolvedCc) ? (existingReport.resolvedCc as string[]) : [],
            clickupTaskUrl: existingReport.resolvedClickupTaskUrl,
          },
        }
      : {}),
    subjectSuffix: await resendSubjectSuffix(reportId),
  });

  // No baseline is created here -- see promoteSentReportToBaseline.
  const finalReport = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId }, include: { previousBaseline: true } });
  const { previousBaseline, ...report } = finalReport;
  return {
    outcome: "SUCCESS",
    report,
    regenerated: existingReport !== null,
    rowsChanged,
    previousBaseline: previousBaseline
      ? { id: previousBaseline.id, baselineDate: previousBaseline.baselineDate, sourceFilename: previousBaseline.sourceFilename }
      : null,
  };
}

/** Plain-language HTTP response for a refused (re)generation -- shared by the upload route and the Regenerate route. */
export function describeRegenerationBlock(block: RegenerationBlock): { status: number; body: Record<string, unknown> } {
  if (block.outcome === "RESEND_CONFIRMATION_REQUIRED") {
    return {
      status: 409,
      body: {
        code: "RESEND_CONFIRMATION_REQUIRED",
        error: "This report was already sent to the client. Changing it and sending again will email them a second time.",
        existingReportId: block.existingReportId,
        sendCount: block.sendCount,
        lastSentAt: block.lastSentAt,
      },
    };
  }
  if (block.outcome === "BASELINE_IN_USE") {
    return {
      status: 409,
      body: {
        code: "BASELINE_IN_USE",
        error: "A newer report for this client already compares against this run, so this run's report can't be changed anymore.",
        laterReportId: block.laterReportId,
      },
    };
  }
  const messages: Record<ReportLockReason, string> = {
    SENDING: "This report is being sent right now. Try again once sending has finished.",
    REJECTED: "This report was rejected, so it can't be regenerated.",
  };
  return { status: 409, body: { code: `REPORT_${block.reason}`, error: messages[block.reason], existingReportId: block.existingReportId } };
}

/** The JSON a successful (re)generation returns to the dashboard. */
export function describeReportGeneration(result: ReportGenerationSuccess) {
  return {
    report: result.report,
    regenerated: result.regenerated,
    rowsChanged: result.rowsChanged,
    previousBaseline: result.previousBaseline,
  };
}
