import { readFile } from "node:fs/promises";
import { prisma } from "../db/client.js";

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
    include: { client: true, run: true },
  });

  if (!report.clientPdfPath) {
    throw new Error(`Report ${reportId} has no clientPdfPath yet -- build the report before sending.`);
  }

  const buffer = await readFile(report.clientPdfPath);
  const safeClientName = report.client.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  const dateStamp = (report.run.completedAt ?? report.run.createdAt).toISOString().slice(0, 10);
  return { buffer, filename: `SEO-Report-${safeClientName}-${dateStamp}.pdf` };
}
