import { prisma } from "../db/client.js";
import { ReportStatus, Prisma } from "@prisma/client";
import { InvalidReportTransitionError } from "./errors.js";

// PENDING_ANALYSIS ──▶ ANALYSIS_READY ──▶ REPORT_READY ──▶ EMAIL_DRAFTED ──▶ PENDING_APPROVAL
//        │        │                           │       ▲                          │        │
//        │   ANALYSIS_FAILED            EMAIL_DRAFT_FAILED                  APPROVED   REJECTED
//        │        │  (retry)                   │  (retry)                       │
//        │        └──▶ PENDING_ANALYSIS        └──▶ REPORT_READY              SENDING
//        │                                                ▲                   │      │
//        └───────────────────────────────────▶ REPORT_READY (Build Report    SENT   APPROVED
//                                                            skips the               (send
//                                                            optional Claude          failed --
//                                                            Insights step            retry
//                                                            entirely)                stays
//                                                                                      possible)
//
// The PENDING_ANALYSIS -> REPORT_READY edge lets "Build Report" run directly
// off the deterministic analyticsJson computed at report-creation time,
// without ever calling Claude -- ANALYSIS_READY -> REPORT_READY still works
// unchanged for reports that did go through Insights first.
//
// The PENDING_APPROVAL -> REPORT_READY edge is an addition made specifically
// to support the "Regenerate" action on the approval screen -- the original
// diagram only drew APPROVED/REJECTED out of PENDING_APPROVAL. Everything
// else here is unchanged from that diagram.
//
// APPROVED -> SENDING -> SENT|APPROVED: SENDING is claimed atomically right
// before the real ClickUp send automation runs (see markSending below) --
// it exists solely so two concurrent approve-and-send calls can never both
// execute sendEmail() for the same report. A failed send reverts SENDING
// back to APPROVED (markSendFailed) so a legitimate retry stays possible;
// nothing can go directly from APPROVED to SENT anymore.
//
// Isolated from RunStatus/RowStatus -- this module never imports from
// backend/statemachine or backend/worker, and nothing there imports this.
export const REPORT_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  PENDING_ANALYSIS: [ReportStatus.ANALYSIS_READY, ReportStatus.ANALYSIS_FAILED, ReportStatus.REPORT_READY],
  ANALYSIS_FAILED: [ReportStatus.PENDING_ANALYSIS],
  ANALYSIS_READY: [ReportStatus.REPORT_READY],
  REPORT_READY: [ReportStatus.EMAIL_DRAFTED, ReportStatus.EMAIL_DRAFT_FAILED],
  EMAIL_DRAFT_FAILED: [ReportStatus.REPORT_READY],
  EMAIL_DRAFTED: [ReportStatus.PENDING_APPROVAL],
  PENDING_APPROVAL: [ReportStatus.APPROVED, ReportStatus.REJECTED, ReportStatus.REPORT_READY],
  APPROVED: [ReportStatus.SENDING],
  SENDING: [ReportStatus.SENT, ReportStatus.APPROVED],
  REJECTED: [],
  SENT: [],
};

export function isValidReportTransition(from: ReportStatus, to: ReportStatus): boolean {
  return REPORT_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Every transition below is a single conditional UPDATE (status must still
 * match one of `fromStatuses`), the same pattern used by the ranking row/run
 * state machine: two concurrent callers racing the same report can't both
 * "win" -- the loser matches zero rows and gets InvalidReportTransitionError.
 *
 * Exported so callers outside this file that need the SAME atomic
 * conditional-update guarantee (e.g. editReportDraft.ts's updateReportDraft,
 * which edits fields while requiring PENDING_APPROVAL without itself being a
 * status transition -- `data` here simply never includes `status`, so it's
 * left untouched) can reuse it instead of re-implementing a weaker
 * read-then-write check.
 */
export async function guardedUpdate(
  reportId: string,
  fromStatuses: ReportStatus[],
  data: Prisma.RankingReportUpdateManyMutationInput,
  action: string,
) {
  const { count } = await prisma.rankingReport.updateMany({
    where: { id: reportId, status: { in: fromStatuses } },
    data,
  });
  if (count === 0) throw new InvalidReportTransitionError(reportId, action);
  return prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId } });
}

/** PENDING_ANALYSIS -> ANALYSIS_READY. Backend-computed analytics + Claude's validated analysis. */
export async function markAnalysisReady(
  reportId: string,
  { analyticsJson, analysisJson }: { analyticsJson: Prisma.InputJsonValue; analysisJson: Prisma.InputJsonValue },
) {
  return guardedUpdate(
    reportId,
    [ReportStatus.PENDING_ANALYSIS],
    { status: ReportStatus.ANALYSIS_READY, analyticsJson, analysisJson, lastErrorMessage: null },
    "mark analysis ready (PENDING_ANALYSIS -> ANALYSIS_READY)",
  );
}

/** PENDING_ANALYSIS -> ANALYSIS_FAILED. */
export async function markAnalysisFailed(reportId: string, { errorMessage }: { errorMessage: string }) {
  return guardedUpdate(
    reportId,
    [ReportStatus.PENDING_ANALYSIS],
    { status: ReportStatus.ANALYSIS_FAILED, lastErrorMessage: errorMessage },
    "mark analysis failed (PENDING_ANALYSIS -> ANALYSIS_FAILED)",
  );
}

/** ANALYSIS_FAILED -> PENDING_ANALYSIS. Re-attempt the Claude Report Analyst step. */
export async function retryAnalysis(reportId: string) {
  return guardedUpdate(
    reportId,
    [ReportStatus.ANALYSIS_FAILED],
    { status: ReportStatus.PENDING_ANALYSIS, lastErrorMessage: null },
    "retry analysis (ANALYSIS_FAILED -> PENDING_ANALYSIS)",
  );
}

/**
 * ANALYSIS_READY -> REPORT_READY, or PENDING_ANALYSIS -> REPORT_READY
 * directly (the "Build Report" step no longer requires the Claude Insights
 * step to have run first -- analyticsJson alone, already present at
 * PENDING_ANALYSIS, is everything the deterministic client PDF needs).
 * Deterministic -- not a Claude step, no failure state.
 *
 * Also callable from REPORT_READY itself: an idempotent self-transition
 * (status doesn't move) that lets Build Report be re-entered safely --
 * clicking it again after going Back, or a double-click/race, regenerates
 * the PDF in place instead of hitting an invalid-transition error. This is
 * NOT a new edge in the state graph (REPORT_READY never reaches back to an
 * earlier state); it's the same status before and after.
 */
export async function markReportReady(
  reportId: string,
  { reportHtml, clientPdfPath }: { reportHtml?: string; clientPdfPath?: string },
) {
  return guardedUpdate(
    reportId,
    [ReportStatus.ANALYSIS_READY, ReportStatus.PENDING_ANALYSIS, ReportStatus.REPORT_READY],
    { status: ReportStatus.REPORT_READY, ...(reportHtml !== undefined ? { reportHtml } : {}), ...(clientPdfPath !== undefined ? { clientPdfPath } : {}) },
    "mark report ready (ANALYSIS_READY|PENDING_ANALYSIS|REPORT_READY -> REPORT_READY)",
  );
}

/** REPORT_READY -> EMAIL_DRAFTED. */
export async function markEmailDrafted(
  reportId: string,
  {
    emailSubject,
    emailBody,
    emailBodyHtml,
    resolvedRecipients,
    resolvedCc,
    resolvedClickupTaskUrl,
  }: {
    emailSubject: string;
    emailBody: string;
    emailBodyHtml?: string | null;
    resolvedRecipients: Prisma.InputJsonValue;
    resolvedCc?: Prisma.InputJsonValue;
    resolvedClickupTaskUrl?: string | null;
  },
) {
  return guardedUpdate(
    reportId,
    [ReportStatus.REPORT_READY],
    {
      status: ReportStatus.EMAIL_DRAFTED,
      emailSubject,
      emailBody,
      emailBodyHtml: emailBodyHtml ?? null,
      resolvedRecipients,
      resolvedCc: resolvedCc ?? Prisma.DbNull,
      resolvedClickupTaskUrl: resolvedClickupTaskUrl ?? null,
      lastErrorMessage: null,
    },
    "mark email drafted (REPORT_READY -> EMAIL_DRAFTED)",
  );
}

/** REPORT_READY -> EMAIL_DRAFT_FAILED. */
export async function markEmailDraftFailed(reportId: string, { errorMessage }: { errorMessage: string }) {
  return guardedUpdate(
    reportId,
    [ReportStatus.REPORT_READY],
    { status: ReportStatus.EMAIL_DRAFT_FAILED, lastErrorMessage: errorMessage },
    "mark email draft failed (REPORT_READY -> EMAIL_DRAFT_FAILED)",
  );
}

/** EMAIL_DRAFT_FAILED -> REPORT_READY. Re-attempt the Claude Email Draft Generator step only. */
export async function retryEmailDraft(reportId: string) {
  return guardedUpdate(
    reportId,
    [ReportStatus.EMAIL_DRAFT_FAILED],
    { status: ReportStatus.REPORT_READY, lastErrorMessage: null },
    "retry email draft (EMAIL_DRAFT_FAILED -> REPORT_READY)",
  );
}

/** EMAIL_DRAFTED -> PENDING_APPROVAL. Surfaces the report in the human approval queue. */
export async function submitForApproval(reportId: string) {
  return guardedUpdate(
    reportId,
    [ReportStatus.EMAIL_DRAFTED],
    { status: ReportStatus.PENDING_APPROVAL },
    "submit for approval (EMAIL_DRAFTED -> PENDING_APPROVAL)",
  );
}

/** PENDING_APPROVAL -> APPROVED. A human decision -- never automatic. */
export async function approveReport(reportId: string, { approvedBy }: { approvedBy: string }) {
  return guardedUpdate(
    reportId,
    [ReportStatus.PENDING_APPROVAL],
    { status: ReportStatus.APPROVED, approvedBy, approvedAt: new Date() },
    "approve report (PENDING_APPROVAL -> APPROVED)",
  );
}

/** PENDING_APPROVAL -> REJECTED. Terminal -- a rejected report's lifecycle ends here. */
export async function rejectReport(reportId: string) {
  return guardedUpdate(
    reportId,
    [ReportStatus.PENDING_APPROVAL],
    { status: ReportStatus.REJECTED },
    "reject report (PENDING_APPROVAL -> REJECTED)",
  );
}

/**
 * APPROVED -> SENDING. Atomically claims the right to actually run the send
 * automation: exactly one concurrent caller can win this conditional
 * UPDATE, so approveAndSendReport calls this immediately before invoking
 * sendEmail, and only proceeds if it wins. A second concurrent call (double
 * -click, retried request, race) loses here -- count is 0, this throws --
 * and is rejected before ever touching ClickUp.
 */
export async function markSending(reportId: string) {
  return guardedUpdate(reportId, [ReportStatus.APPROVED], { status: ReportStatus.SENDING }, "claim send (APPROVED -> SENDING)");
}

/**
 * SENDING -> APPROVED. The send automation failed (threw before reaching
 * markSent) -- reverts the claim so approveAndSendReport can legitimately be
 * retried later, instead of leaving the report stuck in SENDING forever.
 */
export async function markSendFailed(reportId: string, { errorMessage }: { errorMessage: string }) {
  return guardedUpdate(
    reportId,
    [ReportStatus.SENDING],
    { status: ReportStatus.APPROVED, lastErrorMessage: errorMessage },
    "mark send failed (SENDING -> APPROVED)",
  );
}

/**
 * SENDING -> SENT. Terminal -- only reachable from the claimed SENDING
 * state, never directly from APPROVED. `auditCommentPosted` is purely
 * observability (see SendEmailResult) -- whatever value the sender reports
 * (or omits) is recorded, but it never affects whether this transition
 * itself succeeds: by the time this is called, the email has already sent.
 */
export async function markSent(reportId: string, { auditCommentPosted }: { auditCommentPosted?: boolean } = {}) {
  return guardedUpdate(
    reportId,
    [ReportStatus.SENDING],
    { status: ReportStatus.SENT, sentAt: new Date(), auditCommentPosted: auditCommentPosted ?? null },
    "mark sent (SENDING -> SENT)",
  );
}

/**
 * PENDING_APPROVAL -> REPORT_READY. The "Regenerate" action: discards the
 * stale email draft (clearing subject/body/recipients back to null) and
 * sends the report back to the point where a fresh email draft can be
 * generated. Never touches analyticsJson/analysisJson/reportHtml -- only
 * the email draft is being redone.
 */
export async function regenerateEmailDraftFromApproval(reportId: string) {
  return guardedUpdate(
    reportId,
    [ReportStatus.PENDING_APPROVAL],
    {
      status: ReportStatus.REPORT_READY,
      emailSubject: null,
      emailBody: null,
      emailBodyHtml: null,
      resolvedRecipients: Prisma.DbNull,
      resolvedCc: Prisma.DbNull,
      resolvedClickupTaskUrl: null,
      lastErrorMessage: null,
    },
    "regenerate email draft (PENDING_APPROVAL -> REPORT_READY)",
  );
}
