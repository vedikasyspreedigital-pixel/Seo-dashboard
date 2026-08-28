import { readFile } from "node:fs/promises";
import { prisma } from "../db/client.js";
import { exportRankingExcel } from "./exporter.js";

// Shared by both the manual "Download Excel" route (backend/api/routes/runs.ts)
// and report email delivery (backend/reporting/approveAndSend.ts) -- both need
// exactly the same "re-patch the original upload with current row state"
// buffer, so this is the one place that logic lives.
export async function exportRunExcelBuffer(runId: string): Promise<{ buffer: Buffer; filename: string }> {
  const run = await prisma.rankingRun.findUniqueOrThrow({ where: { id: runId } });
  const rows = await prisma.rankingRow.findMany({ where: { runId }, orderBy: { sourceRowNumber: "asc" } });
  const originalBuffer = await readFile(run.sourceFilePath);
  const buffer = (await exportRankingExcel(
    originalBuffer,
    rows.map((r) => ({
      sourceRowNumber: r.sourceRowNumber,
      status: r.status,
      rankDisplay: r.rankDisplay,
      rankingUrl: r.rankingUrl,
    })),
  )) as Buffer;
  return { buffer, filename: run.sourceFilename };
}
