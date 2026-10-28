import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";

/**
 * DataForSEO's full raw answer (the whole Google results page) is stored on every attempt and was kept
 * forever -- the biggest thing in the database, and never read again once the rank is saved. The user's
 * choice (2026-10-28): keep it 40 days. Only that raw answer is emptied: each attempt's record (date,
 * outcome, the rank and URL it found) and every row's rank stay as they are.
 */
export const RAW_RESPONSE_KEEP_DAYS = 40;

export async function pruneOldRawResponses(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RAW_RESPONSE_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.rankingRowAttempt.updateMany({
    where: { createdAt: { lt: cutoff }, rawResponse: { not: Prisma.DbNull } },
    data: { rawResponse: Prisma.DbNull },
  });
  if (count > 0) console.log(`[dataforseo] emptied the raw DataForSEO answer of ${count} attempt(s) older than ${RAW_RESPONSE_KEEP_DAYS} days (ranks kept)`);
  return count;
}
