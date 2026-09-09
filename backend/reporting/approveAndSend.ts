import { prisma } from "../db/client.js";
import { ReportStatus } from "@prisma/client";
import { approveReport, markSending, markSendFailed, markSent } from "./reportTransitions.js";
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
  const cc = Array.isArray(report.resolvedCc) ? (report.resolvedCc as string[]) : [];
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

  // Atomically claim the send BEFORE calling sendEmail: this is what
  // guarantees only one concurrent caller can ever execute sendEmail() for
  // this report. Two requests racing here (double-click, retried request,
  // two tabs) both reach this line with status APPROVED, but only one wins
  // the conditional APPROVED -> SENDING update -- the loser gets
  // InvalidReportTransitionError and returns immediately, never touching
  // ClickUp.
  try {
    current = await markSending(reportId);
  } catch (err) {
    if (err instanceof InvalidReportTransitionError) {
      return { outcome: "ALREADY_PROCESSED", errorMessage: err.message };
    }
    throw err;
  }

  try {
    // The client-facing PDF (Report Summary + one Keyword Ranking Table,
    // built straight from the report's own deterministic analyticsJson),
    // sent alongside the deterministic HTML report -- not instead of it.
    // generateExcelAttachment is optional (like sendEmail/callClaudeAnalyst
    // elsewhere) so tests with fixture reports aren't forced to launch a
    // real Playwright browser just to approve a report.
    let excelPdfBuffer: Buffer | undefined;
    let excelPdfFilename: string | undefined;
    if (generateExcelAttachment) {
      const excelAttachment = await generateExcelAttachment(current.id);
      excelPdfBuffer = excelAttachment.buffer;
      excelPdfFilename = excelAttachment.filename;
    }

    const sendResult = await sendEmail({
      to: recipients,
      cc: cc.length > 0 ? cc : undefined,
      subject: current.emailSubject ?? "",
      bodyText: current.emailBody ?? "",
      bodyHtml: current.emailBodyHtml ?? undefined,
      clickupTaskUrl: current.resolvedClickupTaskUrl ?? undefined,
      attachmentHtml: current.reportHtml ?? undefined,
      attachmentFilename: current.reportHtml ? `seo-report-${reportId}.html` : undefined,
      excelPdfBuffer,
      excelPdfFilename,
    });
    await markSent(reportId, { auditCommentPosted: sendResult.auditCommentPosted });
    return { outcome: "SENT", messageId: sendResult.messageId };
  } catch (err) {
    // Logged server-side because the frontend only ever shows the message
    // text -- without this, diagnosing a live failure meant reading a
    // screenshot instead of the actual Railway logs.
    console.error(`[approveAndSend] send failed for report ${reportId}: ${(err as Error).message}`);
    // Send failed after claiming SENDING. Revert the claim back to
    // APPROVED so calling this function again legitimately retries the
    // send step (see above) -- never leaves the report stuck in SENDING.
    // If the revert itself somehow fails, the ORIGINAL send error is still
    // what the caller needs to see and act on, not the revert failure.
    await markSendFailed(reportId, { errorMessage: (err as Error).message }).catch(() => {});
    return { outcome: "SEND_FAILED", errorMessage: (err as Error).message };
  }
}
