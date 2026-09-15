import type { Prisma } from "@prisma/client";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { guardedUpdate } from "./reportTransitions.js";
import { computeReportPeriod } from "./generateEmailDraft.js";
import { DuplicateReportDateError } from "./errors.js";

// Human editing of the draft (step 15 of the reporting design): only ever
// permitted while a report is sitting in the approval queue -- editing a
// report that's already been sent, rejected, or is mid-generation would
// either be pointless or actively confusing.
//
// Uses the same atomic conditional-update guardedUpdate every real status
// transition uses (reportTransitions.ts), instead of a plain read-then-check
// -then-write: the PENDING_APPROVAL check and the write happen in one
// conditional UPDATE, so a concurrent approve-and-send/regenerate racing
// this edit can't slip in between the check and the write. `data` never
// includes `status`, so this never actually changes it -- it's a guarded
// edit, not a transition.

export interface ReportDraftEdits {
  emailSubject?: string;
  emailBody?: string;
  emailBodyHtml?: string;
  resolvedRecipients?: string[];
  resolvedCc?: string[];
  resolvedClickupTaskUrl?: string | null;
  /** "generated" | "custom" -- which PDF approveAndSendReport attaches. Switching back to "generated" never deletes a previously-uploaded custom PDF, it just stops being the one used. */
  attachmentSource?: string;
}

/**
 * Finds an already-SENT report for the same client covering the identical
 * date range (compared by calendar day, not exact timestamp -- two runs
 * completed minutes apart on the same day still count as the same
 * reporting period) as `report`. This is what catches the case a duplicate
 * upload/run produces: two separate runs, two separate reports, but the
 * same real-world period -- one of which may already have gone out to the
 * client. Returns null when there's nothing to warn about (including when
 * `report` itself has no prior comparison and no other SENT report exists).
 */
export async function findDuplicateDatedReport(report: {
  id: string;
  clientId: string;
  run: { completedAt: Date | null; createdAt: Date };
  previousRun: { completedAt: Date | null; createdAt: Date } | null;
  previousBaseline?: { baselineDate: Date } | null;
}) {
  const { periodStart, periodEnd } = computeReportPeriod(report);
  const startDay = periodStart.toDateString();
  const endDay = periodEnd.toDateString();

  const siblings = await prisma.rankingReport.findMany({
    where: { clientId: report.clientId, id: { not: report.id }, status: ReportStatus.SENT },
    include: { run: true, previousRun: true, previousBaseline: true },
  });

  return siblings.find((sibling) => {
    const siblingPeriod = computeReportPeriod(sibling);
    return siblingPeriod.periodStart.toDateString() === startDay && siblingPeriod.periodEnd.toDateString() === endDay;
  }) ?? null;
}

export async function updateReportDraft(reportId: string, edits: ReportDraftEdits) {
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId }, include: { run: true, previousRun: true, previousBaseline: true } });
  const duplicate = await findDuplicateDatedReport(report);
  if (duplicate) {
    const { periodStart, periodEnd } = computeReportPeriod(report);
    throw new DuplicateReportDateError(reportId, duplicate.id, periodStart, periodEnd);
  }

  const data: Prisma.RankingReportUpdateManyMutationInput = {};
  if (edits.emailSubject !== undefined) data.emailSubject = edits.emailSubject;
  if (edits.emailBody !== undefined) data.emailBody = edits.emailBody;
  if (edits.emailBodyHtml !== undefined) data.emailBodyHtml = edits.emailBodyHtml;
  if (edits.resolvedRecipients !== undefined) data.resolvedRecipients = edits.resolvedRecipients as Prisma.InputJsonValue;
  if (edits.resolvedCc !== undefined) data.resolvedCc = edits.resolvedCc as Prisma.InputJsonValue;
  if (edits.resolvedClickupTaskUrl !== undefined) data.resolvedClickupTaskUrl = edits.resolvedClickupTaskUrl;
  if (edits.attachmentSource !== undefined) data.attachmentSource = edits.attachmentSource;

  return guardedUpdate(reportId, [ReportStatus.PENDING_APPROVAL], data, "edit draft (report must be PENDING_APPROVAL)");
}

/**
 * Records a newly-uploaded custom PDF and switches attachmentSource to
 * "custom" in the same guarded update -- uploading implies intent to use
 * it immediately, matching how every other draft edit here takes effect
 * right away. Never touches clientPdfPath: the generated PDF stays on
 * record regardless of which one ends up attached.
 */
export async function setCustomPdfAttachment(reportId: string, customPdfPath: string, customPdfFilename: string) {
  return guardedUpdate(
    reportId,
    [ReportStatus.PENDING_APPROVAL],
    { customPdfPath, customPdfFilename, attachmentSource: "custom" },
    "upload custom PDF (report must be PENDING_APPROVAL)",
  );
}
