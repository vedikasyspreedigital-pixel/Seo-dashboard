import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { ReportStatus } from "@prisma/client";
import { InvalidReportTransitionError } from "./errors.js";

// Human editing of the draft (step 15 of the reporting design): only ever
// permitted while a report is sitting in the approval queue -- editing a
// report that's already been sent, rejected, or is mid-generation would
// either be pointless or actively confusing.

export interface ReportDraftEdits {
  emailSubject?: string;
  emailBody?: string;
  emailBodyHtml?: string;
  resolvedRecipients?: string[];
  resolvedClickupTaskUrl?: string | null;
}

export async function updateReportDraft(reportId: string, edits: ReportDraftEdits) {
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId } });
  if (report.status !== ReportStatus.PENDING_APPROVAL) {
    throw new InvalidReportTransitionError(reportId, "edit draft (report must be PENDING_APPROVAL)");
  }

  const data: Prisma.RankingReportUpdateInput = {};
  if (edits.emailSubject !== undefined) data.emailSubject = edits.emailSubject;
  if (edits.emailBody !== undefined) data.emailBody = edits.emailBody;
  if (edits.emailBodyHtml !== undefined) data.emailBodyHtml = edits.emailBodyHtml;
  if (edits.resolvedRecipients !== undefined) data.resolvedRecipients = edits.resolvedRecipients as Prisma.InputJsonValue;
  if (edits.resolvedClickupTaskUrl !== undefined) data.resolvedClickupTaskUrl = edits.resolvedClickupTaskUrl;

  return prisma.rankingReport.update({ where: { id: reportId }, data });
}
