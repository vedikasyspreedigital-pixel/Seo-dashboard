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

/**
 * Database getting full (2026-11-05). Since Live asks for the whole top 100 (no `target`), every attempt
 * saves ~100 results instead of the client's 1-2, so the raw answers grow much faster. When the whole
 * database is bigger than RAW_RESPONSE_DB_LIMIT_GB (default 3 GB), raw answers are kept only
 * RAW_RESPONSE_KEEP_DAYS_WHEN_FULL days (default 7) instead of 40. Same rule as above: only the raw
 * answer is emptied, never a rank or an attempt record. Postgres reuses the freed space for new answers
 * (the file itself doesn't shrink until a VACUUM FULL), so this runs on every daily check while it's full.
 */
export const DEFAULT_DB_LIMIT_GB = 3;
export const DEFAULT_KEEP_DAYS_WHEN_FULL = 7;

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function pruneRawResponsesWhenFull(
  { now = new Date(), env = process.env, databaseBytes }: { now?: Date; env?: NodeJS.ProcessEnv; databaseBytes?: () => Promise<number> } = {},
): Promise<{ full: boolean; sizeGb: number; limitGb: number; emptied: number }> {
  const limitGb = positiveNumber(env.RAW_RESPONSE_DB_LIMIT_GB, DEFAULT_DB_LIMIT_GB);
  const keepDays = positiveNumber(env.RAW_RESPONSE_KEEP_DAYS_WHEN_FULL, DEFAULT_KEEP_DAYS_WHEN_FULL);
  const bytes = databaseBytes
    ? await databaseBytes()
    : Number((await prisma.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`)[0].size);
  const sizeGb = Math.round((bytes / 1024 ** 3) * 100) / 100;
  if (sizeGb <= limitGb) return { full: false, sizeGb, limitGb, emptied: 0 };

  const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.rankingRowAttempt.updateMany({
    where: { createdAt: { lt: cutoff }, rawResponse: { not: Prisma.DbNull } },
    data: { rawResponse: Prisma.DbNull },
  });
  console.warn(`[dataforseo] database is ${sizeGb} GB (limit ${limitGb} GB): emptied the raw DataForSEO answer of ${count} attempt(s) older than ${keepDays} days (ranks kept)`);
  return { full: true, sizeGb, limitGb, emptied: count };
}
