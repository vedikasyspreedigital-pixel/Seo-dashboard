import { prisma } from "../db/client.js";
import { normalizeKeyword } from "./normalizeKeyword.js";

/**
 * Share of a run's keywords a baseline must contain to count as the SAME
 * keyword set. A client can track two separate sets as two runs under one
 * client (Eleevate Overseas, 2026-10-15: "regular" and "local keywords",
 * 20 keywords each, only 9 in common = 45%). Ordinary churn -- a few
 * keywords added, dropped or reworded between reports -- stays well above it.
 */
export const SAME_KEYWORD_SET_MIN_SHARE = 0.6;

/** How many earlier baselines are checked for a keyword-set match, newest first. */
const CANDIDATE_LIMIT = 25;

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
 * - Keyword set: the newest baseline holding at least
 *   SAME_KEYWORD_SET_MIN_SHARE of this run's keywords wins, so a client with
 *   two keyword sets compares each run with its own set's previous report.
 *   If no baseline matches that well, the newest one is used, as before.
 */
export async function selectPreviousBaseline(run: { id: string; clientId: string; completedAt: Date | null; createdAt: Date }) {
  const runEnd = run.completedAt ?? run.createdAt;
  const candidates = await prisma.rankingBaseline.findMany({
    where: {
      clientId: run.clientId,
      OR: [
        { sourceRunId: null, baselineDate: { lt: startOfUtcDay(runEnd) } },
        { sourceRunId: { not: run.id }, baselineDate: { lt: runEnd } },
      ],
    },
    orderBy: [{ baselineDate: "desc" }, { createdAt: "desc" }],
    take: CANDIDATE_LIMIT,
  });
  if (candidates.length <= 1) return candidates[0] ?? null;

  const runKeywords = new Set(
    (await prisma.rankingRow.findMany({ where: { runId: run.id }, select: { keyword: true } })).map((r) => normalizeKeyword(r.keyword)),
  );
  if (runKeywords.size === 0) return candidates[0];

  const baselineRows = await prisma.rankingBaselineRow.findMany({
    where: { baselineId: { in: candidates.map((c) => c.id) } },
    select: { baselineId: true, normalizedKeyword: true },
  });
  // Distinct keywords only -- a report can list the same keyword twice.
  const matches = new Map<string, Set<string>>();
  for (const row of baselineRows) {
    if (!runKeywords.has(row.normalizedKeyword)) continue;
    if (!matches.has(row.baselineId)) matches.set(row.baselineId, new Set());
    matches.get(row.baselineId)!.add(row.normalizedKeyword);
  }
  const sameSet = candidates.find((c) => (matches.get(c.id)?.size ?? 0) / runKeywords.size >= SAME_KEYWORD_SET_MIN_SHARE);
  return sameSet ?? candidates[0];
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
