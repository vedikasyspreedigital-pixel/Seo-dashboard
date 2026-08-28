import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../backend/db/client.js";
import { exportRankingExcel } from "../backend/excel/exporter.js";

// Regenerates the Excel export from the CURRENT (corrected) DB state.
// No DataForSEO call is made -- this only reads Postgres and rewrites the
// local result file.

const run = await prisma.rankingRun.findFirstOrThrow({
  where: { sourceFilename: "real-batch-test.xlsx" },
  orderBy: { createdAt: "desc" },
});

const rows = await prisma.rankingRow.findMany({
  where: { runId: run.id },
  orderBy: { sourceRowNumber: "asc" },
});

const originalPath = new URL(
  "../sample-data/real-batch-test.xlsx",
  import.meta.url,
);
const originalBuffer = await readFile(originalPath);

const updatedBuffer = await exportRankingExcel(
  originalBuffer,
  rows.map((r) => ({
    sourceRowNumber: r.sourceRowNumber,
    status: r.status,
    rankDisplay: r.rankDisplay,
    rankingUrl: r.rankingUrl,
  })),
);

const outPath = new URL(
  "../sample-data/real-batch-test-RESULT.xlsx",
  import.meta.url,
);
await writeFile(outPath, updatedBuffer);

console.log(`Run: ${run.id} (status=${run.status})`);
console.log(`Re-exported: ${outPath.pathname}`);
console.table(
  rows.map((r) => ({
    keyword: r.keyword,
    status: r.status,
    rank_display: r.rankDisplay,
    ranking_url: r.rankingUrl,
  })),
);

await prisma.$disconnect();
