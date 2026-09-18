import { prisma } from "../db/client.js";
import { normalizeKeyword } from "./normalizeKeyword.js";
import { BaselineSourceType } from "@prisma/client";

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
  rows: BaselineRowInput[];
}

/**
 * The one place a RankingBaseline (+ its rows) is ever created -- shared by
 * the manual "Upload Previous Ranking" route (backend/api/routes/baselines.ts)
 * and the automatic verified-Excel pipeline (processVerifiedExcelUpload.ts),
 * so both stay one baseline created per call, never overwriting a client's
 * prior baselines (see RankingBaseline's own schema comment).
 */
export async function createBaselineFromRows(clientId: string, input: CreateBaselineFromRowsInput) {
  return prisma.rankingBaseline.create({
    data: {
      clientId,
      sourceFilename: input.sourceFilename,
      sourceType: input.sourceType,
      baselineDate: input.baselineDate,
      createdBy: input.createdBy ?? null,
      rows: {
        create: input.rows.map((row) => ({
          keyword: row.keyword,
          normalizedKeyword: normalizeKeyword(row.keyword),
          rankValue: row.rankValue ?? null,
          rankDisplay: row.rankDisplay ?? null,
        })),
      },
    },
  });
}
