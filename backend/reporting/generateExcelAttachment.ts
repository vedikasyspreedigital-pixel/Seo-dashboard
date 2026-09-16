import { readFile } from "node:fs/promises";
import { prisma } from "../db/client.js";
import { computeReportPeriod } from "./generateEmailDraft.js";
import { formatOrdinalDate } from "./formatOrdinalDate.js";

export interface ExcelAttachment {
  buffer: Buffer;
  filename: string;
}

export type GenerateExcelAttachmentFn = (reportId: string) => Promise<ExcelAttachment>;

/**
 * Real implementation, injected into approveAndSendReport exactly like
 * sendEmail/callClaudeAnalyst -- kept optional there so tests that
 * construct fixture reports aren't forced to touch the filesystem just to
 * approve a report.
 *
 * Reads the client-facing PDF (Report Summary + one Keyword Ranking Table)
 * that buildReport already generated and stored at clientPdfPath -- the
 * SAME file the PDF Preview page showed. Never regenerates it: there is
 * exactly one generated artifact per report, produced once at Build Report
 * time, reused for both preview and the email attachment.
 */
export async function generateExcelPdfAttachment(reportId: string): Promise<ExcelAttachment> {
  const report = await prisma.rankingReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { client: true, run: true, previousRun: true, previousBaseline: true },
  });

  if (!report.clientPdfPath) {
    throw new Error(`Report ${reportId} has no clientPdfPath yet -- build the report before sending.`);
  }

  const buffer = await readFile(report.clientPdfPath);
  // Same canonical period (and the same ordinal date formatting) the
  // Subject/Body use -- "{Client} - Keyword Ranking Report - {start} -
  // {end}.pdf", e.g. "Emirates Sound - Keyword Ranking Report - 17th
  // August 2026 - 31st August 2026.pdf". Only filesystem-illegal
  // characters are stripped from the client name; spaces are kept.
  const { periodStart, periodEnd } = computeReportPeriod(report);
  const safeClientName = report.client.name.replace(/[\\/:*?"<>|]/g, "").trim();
  const filename = `${safeClientName} - Keyword Ranking Report - ${formatOrdinalDate(periodStart)} - ${formatOrdinalDate(periodEnd)}.pdf`;
  return { buffer, filename };
}
