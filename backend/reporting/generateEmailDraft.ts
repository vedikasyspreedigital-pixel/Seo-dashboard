import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { buildDefaultEmailDraft } from "./emailDraft.js";
import { markEmailDrafted, submitForApproval, regenerateEmailDraftFromApproval } from "./reportTransitions.js";

// The email draft service: fills the standard template with the report's
// real period dates, then -- always successfully, since there's no external
// call to fail -- resolves recipients/cc (never AI-decided) from
// ClientReportConfig and drives the state machine
// REPORT_READY -> EMAIL_DRAFTED -> PENDING_APPROVAL.

/**
 * ClickUp Task ID is the primary way to point a client at their delivery
 * task; the raw Task URL is the fallback for when no ID is set (or for a
 * one-off task that doesn't fit the id-in-URL convention). Pure and
 * side-effect-free so it's independently testable -- ClickUp task URLs are
 * always of the form https://app.clickup.com/t/{taskId}, confirmed via the
 * "https://app.clickup.com/t/xxxxxxx" placeholder already shown in the
 * Email Draft UI's ClickUp task field.
 */
export function resolveClickupTaskUrl(config: { clickupTaskId?: string | null; clickupTaskUrl?: string | null } | null | undefined): string | null {
  if (config?.clickupTaskId) return `https://app.clickup.com/t/${config.clickupTaskId}`;
  return config?.clickupTaskUrl ?? null;
}

export type GenerateEmailDraftResult = { outcome: "SUCCESS"; subject: string; bodyText: string; bodyHtml?: string; recipients: unknown; cc: unknown };

export async function generateEmailDraft(reportId: string): Promise<GenerateEmailDraftResult> {
  const report = await prisma.rankingReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { client: true, run: true, previousRun: true },
  });

  const config = await prisma.clientReportConfig.findFirst({
    where: { clientId: report.clientId, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  const periodStart = report.previousRun?.completedAt ?? report.previousRun?.createdAt ?? report.run.completedAt ?? report.run.createdAt;
  const periodEnd = report.run.completedAt ?? report.run.createdAt;

  const draft = buildDefaultEmailDraft({ clientName: report.client.name, periodStart, periodEnd });

  // Recipients (and cc, and the ClickUp task to deliver through) come from
  // the client's own configuration, resolved by the backend -- never
  // AI-decided.
  const recipients = config?.recipients ?? [];
  const cc = config?.cc ?? [];
  const clickupTaskUrl = resolveClickupTaskUrl(config);

  await markEmailDrafted(reportId, {
    emailSubject: draft.subject,
    emailBody: draft.bodyText,
    emailBodyHtml: draft.bodyHtml,
    resolvedRecipients: recipients as Prisma.InputJsonValue,
    resolvedCc: cc as Prisma.InputJsonValue,
    resolvedClickupTaskUrl: clickupTaskUrl,
  });
  await submitForApproval(reportId);

  return { outcome: "SUCCESS", subject: draft.subject, bodyText: draft.bodyText, bodyHtml: draft.bodyHtml, recipients, cc };
}

/**
 * The "Regenerate" action from the approval screen: discards the current
 * draft (PENDING_APPROVAL -> REPORT_READY, clearing subject/body/recipients/cc)
 * and immediately re-runs generateEmailDraft to produce a fresh one (the same
 * default template -- this is effectively "reset to the default template").
 */
export async function regenerateEmailDraft(reportId: string): Promise<GenerateEmailDraftResult> {
  await regenerateEmailDraftFromApproval(reportId);
  return generateEmailDraft(reportId);
}
