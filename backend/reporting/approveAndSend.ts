import { prisma } from "../db/client.js";
import { ReportStatus } from "@prisma/client";
import { approveReport, markSent } from "./reportTransitions.js";
import { InvalidReportTransitionError } from "./errors.js";
import type { SendEmailFn } from "./emailSender.js";
import type { GenerateExcelAttachmentFn } from "./generateExcelAttachment.js";

// Ties the approval decision to the actual send, with recipients resolved
// entirely from what was already persisted at draft time (ClientReportConfig,
// via generateEmailDraft.ts) -- this function never receives or looks up
// recipients from anywhere else, and never asks Claude anything.

export type ApproveAndSendResult =
  | { outcome: "SENT"; messageId: string }
  | { outcome: "NO_RECIPIENTS"; errorMessage: string }
  | { outcome: "ALREADY_PROCESSED"; errorMessage: string }
  | { outcome: "SEND_FAILED"; errorMessage: string };

export async function approveAndSendReport(
  reportId: string,
  {
    approvedBy,
    sendEmail,
    generateExcelAttachment,
  }: { approvedBy: string; sendEmail: SendEmailFn; generateExcelAttachment?: GenerateExcelAttachmentFn },
): Promise<ApproveAndSendResult> {
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId } });

  // A report already SENT/REJECTED/etc. is not re-processed. This is the
  // first half of duplicate-send protection: a second call after a
  // successful send (double-click, retried request) never reaches sendEmail.
  if (report.status !== ReportStatus.PENDING_APPROVAL && report.status !== ReportStatus.APPROVED) {
    return { outcome: "ALREADY_PROCESSED", errorMessage: `Report is ${report.status}, not awaiting approval.` };
  }

  const recipients = Array.isArray(report.resolvedRecipients) ? (report.resolvedRecipients as string[]) : [];
  if (recipients.length === 0) {
    return { outcome: "NO_RECIPIENTS", errorMessage: "Cannot send: no recipients configured for this report." };
  }

  let current = report;
  if (report.status === ReportStatus.PENDING_APPROVAL) {
    // The atomic guard inside approveReport is the second half of
    // duplicate-send protection: if two requests race here, only one wins
    // this conditional UPDATE; the loser throws and never calls sendEmail.
    try {
      current = await approveReport(reportId, { approvedBy });
    } catch (err) {
      if (err instanceof InvalidReportTransitionError) {
        return { outcome: "ALREADY_PROCESSED", errorMessage: err.message };
      }
      throw err;
    }
  }
  // else: report.status was already APPROVED -- a previous send attempt
  // failed after approval succeeded. This call is a retry of the send
  // step only; approval is not repeated.

  try {
    // The actual ranking Excel (re-patched with current row state -- the
    // same file "Download Excel" produces), converted to PDF, sent
    // alongside the deterministic HTML report -- not instead of it.
    // generateExcelAttachment is optional (like sendEmail/callClaudeAnalyst
    // elsewhere) so tests with fixture runs that have no real file on disk
    // aren't forced to exercise real file I/O or a real Playwright browser.
    let excelPdfBuffer: Buffer | undefined;
    let excelPdfFilename: string | undefined;
    if (generateExcelAttachment) {
      const excelAttachment = await generateExcelAttachment(current.runId);
      excelPdfBuffer = excelAttachment.buffer;
      excelPdfFilename = excelAttachment.filename;
    }

    const sendResult = await sendEmail({
      to: recipients,
      subject: current.emailSubject ?? "",
      bodyText: current.emailBody ?? "",
      bodyHtml: current.emailBodyHtml ?? undefined,
      clickupTaskUrl: current.resolvedClickupTaskUrl ?? undefined,
      attachmentHtml: current.reportHtml ?? undefined,
      attachmentFilename: current.reportHtml ? `seo-report-${reportId}.html` : undefined,
      excelPdfBuffer,
      excelPdfFilename,
    });
    await markSent(reportId);
    return { outcome: "SENT", messageId: sendResult.messageId };
  } catch (err) {
    // Send failed after approval succeeded. There is no APPROVED-failure
    // state in the design -- the report simply stays APPROVED, and calling
    // this function again will retry only the send step (see above).
    return { outcome: "SEND_FAILED", errorMessage: (err as Error).message };
  }
}
