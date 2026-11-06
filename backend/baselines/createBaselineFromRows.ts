import { prisma } from "../db/client.js";
import { normalizeKeyword } from "./normalizeKeyword.js";
import { BaselineSourceType, Prisma, type RankingBaseline } from "@prisma/client";

/** The prisma client, or a transaction from prisma.$transaction(async (tx) => ...). */
type Db = Prisma.TransactionClient;

export interface BaselineRowInput {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
}

export interface CreateBaselineFromRowsInput {
  sourceFilename: string;
  sourceType: BaselineSourceType;
  baselineDate: Date;
  createdBy?: string | null;
  /** The run whose verified-Excel upload produced this baseline; omitted for a manual import. */
  sourceRunId?: string | null;
  rows: BaselineRowInput[];
}

function toRowCreates(rows: BaselineRowInput[]) {
  return rows.map((row) => ({
    keyword: row.keyword,
    normalizedKeyword: normalizeKeyword(row.keyword),
    rankValue: row.rankValue ?? null,
    rankDisplay: row.rankDisplay ?? null,
  }));
}

/**
 * The one place a RankingBaseline (+ its rows) is ever created -- shared by
 * the manual "Upload Previous Ranking" route (backend/api/routes/baselines.ts)
 * and the automatic verified-Excel pipeline (processVerifiedExcelUpload.ts),
 * so both stay one baseline created per call, never overwriting a client's
 * prior baselines (see RankingBaseline's own schema comment).
 */
export async function createBaselineFromRows(clientId: string, input: CreateBaselineFromRowsInput, db: Db = prisma) {
  return db.rankingBaseline.create({
    data: {
      clientId,
      sourceFilename: input.sourceFilename,
      sourceType: input.sourceType,
      baselineDate: input.baselineDate,
      createdBy: input.createdBy ?? null,
      sourceRunId: input.sourceRunId ?? null,
      rows: { create: toRowCreates(input.rows) },
    },
  });
}

/**
 * A run's verified-Excel upload produces exactly ONE baseline for that run:
 * the first upload creates it, every later re-upload/regenerate replaces its
 * rows and date in place (never stacking a second baseline for the same run).
 * Manual imports and other runs' baselines are never touched.
 */
export async function upsertRunBaseline(
  clientId: string,
  runId: string,
  input: Omit<CreateBaselineFromRowsInput, "sourceRunId">,
  tx?: Db,
): Promise<RankingBaseline> {
  if (!tx) return prisma.$transaction((t): Promise<RankingBaseline> => upsertRunBaseline(clientId, runId, input, t));

  const existing = await tx.rankingBaseline.findFirst({ where: { clientId, sourceRunId: runId }, orderBy: { createdAt: "desc" } });
  if (!existing) return createBaselineFromRows(clientId, { ...input, sourceRunId: runId }, tx);

  await tx.rankingBaselineRow.deleteMany({ where: { baselineId: existing.id } });
  await tx.rankingBaselineRow.createMany({ data: toRowCreates(input.rows).map((row) => ({ ...row, baselineId: existing.id })) });
  return tx.rankingBaseline.update({
    where: { id: existing.id },
    data: { sourceFilename: input.sourceFilename, sourceType: input.sourceType, baselineDate: input.baselineDate, createdBy: input.createdBy ?? existing.createdBy },
  });
}
