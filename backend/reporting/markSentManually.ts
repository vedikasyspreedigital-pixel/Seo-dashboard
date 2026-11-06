import { BaselineSourceType, ReportStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { upsertRunBaseline, type BaselineRowInput } from "../baselines/createBaselineFromRows.js";
import { normalizeKeyword } from "../baselines/normalizeKeyword.js";

/**
 * "Mark as sent manually" (2026-11-06). Sometimes the team doesn't send the generated report: they send
 * their own report from ClickUp, or a dashboard send dies halfway (Kalessie, 3 Nov: approved, the server
 * restarted mid-send, the team finished it by hand) -- and the dashboard never learns it went out, so no
 * baseline is saved and the next report compares against an old date.
 *
 * This marks the report SENT WITHOUT emailing anyone, and saves the ranks of the file the client actually
 * got (uploaded right after clicking the button) as this run's baseline, dated by that file. Status, send
 * history and baseline are written in one transaction: either all of it is saved or none of it.
 */

/** Statuses a report can be marked sent from: built, not being sent right now, not already final. */
export const MANUAL_SEND_FROM: ReportStatus[] = [
  ReportStatus.REPORT_READY,
  ReportStatus.EMAIL_DRAFT_FAILED,
  ReportStatus.EMAIL_DRAFTED,
  ReportStatus.PENDING_APPROVAL,
  ReportStatus.APPROVED,
];

/** Below this share of the report's keywords found in the file, it's treated as the wrong file. */
export const MIN_KEYWORD_MATCH = 0.5;

export interface ManualSendFile {
  sourceFilename: string;
  sourceType: BaselineSourceType;
  /** The date of the ranks in the file (its newest date column) -- becomes the baseline date. */
  baselineDate: Date;
  rows: BaselineRowInput[];
}

export type MarkSentManuallyResult =
  | { outcome: "SENT"; baselineId: string; matched: number; total: number }
  | { outcome: "NOT_FOUND" }
  | { outcome: "WRONG_STATUS"; status: ReportStatus }
  | { outcome: "INVALID"; error: string }
  | { outcome: "WRONG_FILE"; matched: number; total: number };

/** How many of the run's keywords appear in the file (same keyword normalisation as baseline comparison). */
export function countKeywordMatches(runKeywords: string[], fileRows: { keyword: string }[]) {
  const inFile = new Set(fileRows.map((r) => normalizeKeyword(r.keyword)));
  const wanted = new Set(runKeywords.map(normalizeKeyword));
  let matched = 0;
  for (const k of wanted) if (inFile.has(k)) matched++;
  return { matched, total: wanted.size };
}

/** Why the rows can't be saved as a baseline, or null when they're fine (same rules as the baseline import). */
export function validateManualRows(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return "The file has no keyword rows.";
  for (const row of rows as BaselineRowInput[]) {
    if (typeof row?.keyword !== "string" || row.keyword.trim().length === 0) return "Every row must have a keyword.";
    const rank = row.rankValue;
    if (rank !== null && rank !== undefined && !(Number.isInteger(rank) && rank >= 1 && rank <= 100)) {
      return `"${row.keyword}": rank must be a whole number from 1 to 100, or empty for Not in 100`;
    }
    if (row.rankDisplay !== null && row.rankDisplay !== undefined && typeof row.rankDisplay !== "string") {
      return `"${row.keyword}": rankDisplay must be text`;
    }
  }
  return null;
}

export async function markReportSentManually(
  reportId: string,
  { markedBy, sentAt, file }: { markedBy: string; sentAt: Date; file: ManualSendFile },
): Promise<MarkSentManuallyResult> {
  const report = await prisma.rankingReport.findUnique({ where: { id: reportId } });
  if (!report) return { outcome: "NOT_FOUND" };
  if (!MANUAL_SEND_FROM.includes(report.status)) return { outcome: "WRONG_STATUS", status: report.status };

  const invalid = validateManualRows(file.rows);
  if (invalid) return { outcome: "INVALID", error: invalid };
  if (Number.isNaN(sentAt.getTime()) || sentAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    return { outcome: "INVALID", error: "The sent date must be a real date, not in the future." };
  }
  if (Number.isNaN(file.baselineDate.getTime())) return { outcome: "INVALID", error: "The file's ranking date couldn't be read." };

  // The wrong client's file (or last month's keyword set) must never become the baseline.
  const runRows = await prisma.rankingRow.findMany({ where: { runId: report.runId }, select: { keyword: true } });
  const { matched, total } = countKeywordMatches(runRows.map((r) => r.keyword), file.rows);
  if (total > 0 && matched / total < MIN_KEYWORD_MATCH) return { outcome: "WRONG_FILE", matched, total };

  const baselineId = await prisma.$transaction(async (tx) => {
    // Conditional update: if someone sent or rejected it a moment ago, nothing is written.
    const { count } = await tx.rankingReport.updateMany({
      where: { id: reportId, status: { in: MANUAL_SEND_FROM } },
      data: {
        status: ReportStatus.SENT,
        sentAt,
        approvedBy: report.approvedBy ?? markedBy,
        approvedAt: report.approvedAt ?? new Date(),
        lastErrorMessage: null,
      },
    });
    if (count === 0) return null;
    await tx.reportSend.create({
      data: { reportId, sentAt, sentBy: markedBy, subject: report.emailSubject, manual: true, sourceFilename: file.sourceFilename },
    });
    const baseline = await upsertRunBaseline(
      report.clientId,
      report.runId,
      { sourceFilename: file.sourceFilename, sourceType: file.sourceType, baselineDate: file.baselineDate, createdBy: markedBy, rows: file.rows },
      tx,
    );
    return baseline.id;
  }, { timeout: 30_000 });

  if (!baselineId) {
    const now = await prisma.rankingReport.findUnique({ where: { id: reportId }, select: { status: true } });
    return { outcome: "WRONG_STATUS", status: now?.status ?? report.status };
  }
  return { outcome: "SENT", baselineId, matched, total };
}
