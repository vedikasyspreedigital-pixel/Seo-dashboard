import type { Prisma } from "@prisma/client";
import { ReportStatus } from "@prisma/client";
import { guardedUpdate } from "./reportTransitions.js";

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

export async function updateReportDraft(reportId: string, edits: ReportDraftEdits) {
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
