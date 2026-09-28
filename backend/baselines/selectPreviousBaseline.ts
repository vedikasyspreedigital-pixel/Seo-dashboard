import { prisma } from "../db/client.js";

/**
 * The baseline a run's report compares against: the client's baseline with
 * the most recent RANKING date (baselineDate) before this run finished --
 * not the most recently uploaded one. Upload order used to decide this,
 * which meant an older report imported later (e.g. uploaded on the 21st but
 * holding 15th-September ranks) silently became "previous".
 *
 * - An imported baseline ("Upload Previous Ranking") only has a calendar day
 *   (stored as midnight UTC), so it counts only if that day is before the
 *   run's day -- a same-day import is that run's own data, never "previous".
 * - A baseline another run produced carries the exact time its report was
 *   built, so it counts if that time is before this run finished (two runs
 *   on the same day still compare in order).
 * - The run's OWN baseline (produced by its verified-Excel upload) is always
 *   excluded, so re-uploading or regenerating a report keeps comparing
 *   against the same previous baseline every time.
 * - Ties on the same ranking date go to the latest upload, so a corrected
 *   re-import of the same report wins over the original.
 */
export async function selectPreviousBaseline(run: { id: string; clientId: string; completedAt: Date | null; createdAt: Date }) {
  const runEnd = run.completedAt ?? run.createdAt;
  return prisma.rankingBaseline.findFirst({
    where: {
      clientId: run.clientId,
      OR: [
        { sourceRunId: null, baselineDate: { lt: startOfUtcDay(runEnd) } },
        { sourceRunId: { not: run.id }, baselineDate: { lt: runEnd } },
      ],
    },
    orderBy: [{ baselineDate: "desc" }, { createdAt: "desc" }],
  });
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
