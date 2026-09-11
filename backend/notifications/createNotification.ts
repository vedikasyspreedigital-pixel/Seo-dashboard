import { prisma } from "../db/client.js";
import type { NotificationType } from "@prisma/client";

// Thin persistence layer for the notification panel/bell. Every producer
// below resolves its own workspaceId via the client (Notification has no
// direct link to RankingRun/RankingReport's other fields, only IDs -- kept
// that way so a notification survives even if its source row is later
// pruned/reorganized). A client with no workspace assigned yet (see
// Client.workspaceId's own nullable-by-design comment in schema.prisma)
// has nowhere to notify into, so these silently no-op rather than throw --
// losing a notification is fine, blocking the actual run/report action
// over Failure to notify would not be.

export interface CreateNotificationInput {
  workspaceId: string;
  type: NotificationType;
  message: string;
  clientId?: string | null;
  runId?: string | null;
  reportId?: string | null;
}

export async function createNotification(input: CreateNotificationInput) {
  return prisma.notification.create({
    data: {
      workspaceId: input.workspaceId,
      type: input.type,
      message: input.message,
      clientId: input.clientId ?? null,
      runId: input.runId ?? null,
      reportId: input.reportId ?? null,
    },
  });
}

/** Fires from processRun.ts right after recomputeRunCompletion resolves a run to a terminal, genuinely-completed state (never for CANCELLED -- that's a user action, not an outcome worth a notification). */
export async function notifyRunCompletion(run: { id: string; clientId: string; status: string; sourceFilename: string }): Promise<void> {
  if (run.status !== "COMPLETED" && run.status !== "COMPLETED_WITH_ERRORS") return;
  const client = await prisma.client.findUnique({ where: { id: run.clientId }, select: { workspaceId: true, name: true } });
  if (!client?.workspaceId) return;

  const withErrors = run.status === "COMPLETED_WITH_ERRORS";
  await createNotification({
    workspaceId: client.workspaceId,
    type: withErrors ? "RUN_COMPLETED_WITH_ERRORS" : "RUN_COMPLETED",
    message: withErrors
      ? `Run completed with errors: ${client.name} — ${run.sourceFilename}`
      : `Run completed: ${client.name} — ${run.sourceFilename}`,
    clientId: run.clientId,
    runId: run.id,
  });
}

/** Fires from approveAndSend.ts right after a send succeeds (markSent). */
export async function notifyReportSent(report: { id: string; clientId: string }): Promise<void> {
  const client = await prisma.client.findUnique({ where: { id: report.clientId }, select: { workspaceId: true, name: true } });
  if (!client?.workspaceId) return;

  await createNotification({
    workspaceId: client.workspaceId,
    type: "REPORT_SENT",
    message: `Report sent: ${client.name}`,
    clientId: report.clientId,
    reportId: report.id,
  });
}

/** Fires from approveAndSend.ts's catch block right after a send fails (markSendFailed). */
export async function notifyReportSendFailed(report: { id: string; clientId: string }, errorMessage: string): Promise<void> {
  const client = await prisma.client.findUnique({ where: { id: report.clientId }, select: { workspaceId: true, name: true } });
  if (!client?.workspaceId) return;

  await createNotification({
    workspaceId: client.workspaceId,
    type: "REPORT_SEND_FAILED",
    message: `Report send failed: ${client.name} — ${errorMessage}`,
    clientId: report.clientId,
    reportId: report.id,
  });
}
