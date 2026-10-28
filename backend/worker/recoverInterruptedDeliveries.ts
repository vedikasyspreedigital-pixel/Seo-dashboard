import { prisma } from '../db/client.js';
import { ReportStatus } from '@prisma/client';
import { markSendFailed } from '../reporting/reportTransitions.js';

/**
 * Called once at server startup. A ranking report still SENDING, or a Domain
 * Intelligence report still POSTING, has no live send behind it -- the process
 * doing it is gone (restart, deploy, crash). Left alone it stayed that way
 * forever: SENDING can't be retried or regenerated, and the page only offers
 * Retry for a failed post (audit 2026-10-27).
 *
 * Whether the email/comment actually went out is UNKNOWN, so nothing is
 * resent automatically. Each report becomes retryable with a reason that says
 * to check ClickUp first -- and a retry is still safe: the email sender
 * refuses to send when the email is already on the task, and the comment
 * poster does the same with its "Ref DI-..." marker.
 *
 * `onlyClientId` limits the sweep to one client (tests share one database).
 */
export const INTERRUPTED_MESSAGE =
  'The server restarted while this was being sent, so it is not known whether it went out. Check the ClickUp task before retrying -- a retry will not send it twice if it is already there.';

export async function recoverInterruptedDeliveries({ onlyClientId }: { onlyClientId?: string } = {}): Promise<{ reports: number; domainReports: number; domainBuilds: number }> {
  const clientFilter = onlyClientId ? { clientId: onlyClientId } : {};

  const sending = await prisma.rankingReport.findMany({ where: { status: ReportStatus.SENDING, ...clientFilter }, select: { id: true } });
  let reports = 0;
  for (const { id } of sending) {
    // SENDING -> APPROVED, guarded: one that finished meanwhile is left alone.
    if (await markSendFailed(id, { errorMessage: INTERRUPTED_MESSAGE }).then(() => true, () => false)) reports++;
  }

  const { count: domainReports } = await prisma.domainReport.updateMany({
    where: { status: 'POSTING', ...clientFilter },
    data: { status: 'POST_FAILED', error: INTERRUPTED_MESSAGE },
  });

  // A Domain Intelligence report whose files were being built when the server stopped stayed "Generating"
  // forever (audit 2026-10-27): its files are incomplete, so it's marked failed -- run it again.
  const { count: domainBuilds } = await prisma.domainReport.updateMany({
    where: { status: 'GENERATING', ...clientFilter },
    data: { status: 'FAILED', error: 'The server restarted while the files were being built -- run it again.' },
  });

  if (reports + domainReports + domainBuilds > 0) {
    console.warn(
      `Startup: ${reports} report send(s), ${domainReports} Domain Intelligence post(s) and ${domainBuilds} Domain Intelligence build(s) were cut off by a restart.`,
    );
  }
  return { reports, domainReports, domainBuilds };
}
