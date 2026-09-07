import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { buildEmailDraftInput, runEmailDraftGenerator, type CallClaudeEmailDraftFn } from "./emailDraft.js";
import { markEmailDrafted, markEmailDraftFailed, submitForApproval, regenerateEmailDraftFromApproval } from "./reportTransitions.js";
import type { RunAnalytics } from "./computeRunAnalytics.js";
import type { AnalystOutput } from "./reportAnalyst.js";

// The email draft service: uses the RankingReport's already-validated
// analyticsJson/analysisJson (from the report generation step), drafts an
// email via the injected Claude client, then -- on success -- resolves
// recipients from ClientReportConfig (never from Claude) and drives the
// state machine EMAIL_DRAFTED -> PENDING_APPROVAL. On failure, the report
// lands in EMAIL_DRAFT_FAILED, retryable via reportTransitions.retryEmailDraft.

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

export type GenerateEmailDraftResult =
  | { outcome: "SUCCESS"; subject: string; bodyText: string; bodyHtml?: string; recipients: unknown }
  | { outcome: "VALIDATION_ERROR"; errorMessage: string }
  | { outcome: "CALL_ERROR"; errorMessage: string };

export async function generateEmailDraft(reportId: string, callClaude: CallClaudeEmailDraftFn): Promise<GenerateEmailDraftResult> {
  const report = await prisma.rankingReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { client: true },
  });

  const config = await prisma.clientReportConfig.findFirst({
    where: { clientId: report.clientId, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  const analytics = report.analyticsJson as unknown as RunAnalytics;
  const analysis = report.analysisJson as unknown as AnalystOutput | null;

  const input = buildEmailDraftInput({
    clientName: report.client.name,
    analytics,
    analysis,
    tone: config?.reportTone ?? "professional",
  });

  const result = await runEmailDraftGenerator(input, callClaude);

  if (result.outcome !== "SUCCESS") {
    const errorMessage = result.outcome === "CALL_ERROR" ? result.errorMessage : result.errors.join("; ");
    await markEmailDraftFailed(reportId, { errorMessage });
    return { outcome: result.outcome, errorMessage };
  }

  // Recipients (and the ClickUp task to deliver through) come from the
  // client's own configuration, resolved by the backend -- Claude's output
  // never had either field to read in the first place (EmailDraftInput
  // carries neither, and validateEmailDraftOutput rejects any unexpected
  // key in the output).
  const recipients = config?.recipients ?? [];
  const clickupTaskUrl = resolveClickupTaskUrl(config);

  await markEmailDrafted(reportId, {
    emailSubject: result.data.subject,
    emailBody: result.data.bodyText,
    emailBodyHtml: result.data.bodyHtml,
    resolvedRecipients: recipients as Prisma.InputJsonValue,
    resolvedClickupTaskUrl: clickupTaskUrl,
  });
  await submitForApproval(reportId);

  return { outcome: "SUCCESS", subject: result.data.subject, bodyText: result.data.bodyText, bodyHtml: result.data.bodyHtml, recipients };
}

/**
 * The "Regenerate" action from the approval screen: discards the current
 * draft (PENDING_APPROVAL -> REPORT_READY, clearing subject/body/recipients)
 * and immediately re-runs generateEmailDraft to produce a fresh one. Ends
 * at PENDING_APPROVAL again on success, or EMAIL_DRAFT_FAILED if the new
 * attempt itself fails.
 */
export async function regenerateEmailDraft(reportId: string, callClaude: CallClaudeEmailDraftFn): Promise<GenerateEmailDraftResult> {
  await regenerateEmailDraftFromApproval(reportId);
  return generateEmailDraft(reportId, callClaude);
}
