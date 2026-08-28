import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../backend/db/client.js";
import { parseRankingExcel } from "../backend/excel/parser.js";
import { exportRankingExcel } from "../backend/excel/exporter.js";
import { ingestExcelRun } from "../backend/runs/ingestExcelRun.js";
import { buildDataForSeoRequest } from "../backend/dataforseo/buildRequest.js";
import { recordAttemptAndApply } from "../backend/dataforseo/recordAttemptAndApply.js";
import { dequeueRow } from "../backend/statemachine/rowTransitions.js";
import {
  startRun,
  recomputeRunCompletion,
} from "../backend/statemachine/runTransitions.js";

// Full pipeline against REAL DataForSEO, one call per row (no batching --
// confirmed DataForSEO limitation). Writes only to the local Postgres
// container and to a local Excel export file. No Google Sheets involved.

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* vars may already be set */
  }
}

const dbUrl = process.env.DATABASE_URL ?? "(not set)";
if (!dbUrl.includes("localhost:5433")) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not point at localhost:5433 (got: ${dbUrl})`,
  );
}

const login = process.env.DATAFORSEO_LOGIN;
const password = process.env.DATAFORSEO_PASSWORD;
if (!login || !password) {
  throw new Error(
    "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set (see serp-interpreter/.env)",
  );
}
const authHeader =
  "Basic " + Buffer.from(`${login}:${password}`).toString("base64");

async function callDataForSeo(requestPayload) {
  try {
    const response = await fetch(
      "https://api.dataforseo.com/v3/serp/google/organic/live/regular", // switched from advanced -- see 40102 investigation
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      },
    );
    const body = await response.json();
    return { httpStatus: response.status, body };
  } catch (transportError) {
    return { transportError };
  }
}

const filePath = new URL(
  "../sample-data/real-batch-test.xlsx",
  import.meta.url,
);
const originalBuffer = await readFile(filePath);

const client = await prisma.client.create({
  data: { name: "Real Batch Test - Cash For Cars Perth" },
});

const { run, insertedRowCount, rowErrors } = await ingestExcelRun({
  clientId: client.id,
  sourceFilename: "real-batch-test.xlsx",
  sourceFilePath: filePath.pathname,
  fileBuffer: originalBuffer,
});

console.log(
  `Created run ${run.id} for client ${client.id}: ${insertedRowCount} rows inserted, ${rowErrors.length} rejected.`,
);
if (rowErrors.length > 0) console.log("Rejected rows:", rowErrors);

await startRun(run.id);

const pendingRows = await prisma.rankingRow.findMany({
  where: { runId: run.id, status: "PENDING" },
});

const results = [];
let totalCost = 0;

for (const row of pendingRows) {
  await dequeueRow(row.id);
  const requestPayload = buildDataForSeoRequest(row);
  console.log(`\nCalling DataForSEO for "${row.keyword}"...`);
  const { httpStatus, body, transportError } =
    await callDataForSeo(requestPayload);

  const { row: updatedRow, mapped } = await recordAttemptAndApply(row.id, {
    requestPayload,
    httpStatus,
    responseBody: body,
    transportError,
  });

  const cost = body?.tasks?.[0]?.cost ?? 0;
  totalCost += cost;

  results.push({
    keyword: row.keyword,
    status: updatedRow.status,
    rank: updatedRow.rankDisplay,
    ranking_url: updatedRow.rankingUrl,
    cost,
    outcome: mapped.outcome,
  });
}

const finalRun = await recomputeRunCompletion(run.id);

console.log("\n--- Per-row results ---");
console.table(results);
console.log(`Total DataForSEO cost for this batch: $${totalCost.toFixed(4)}`);
console.log(`Run final status: ${finalRun?.status ?? "(unchanged)"}`);

const allRows = await prisma.rankingRow.findMany({
  where: { runId: run.id },
  orderBy: { sourceRowNumber: "asc" },
});
const updatedBuffer = await exportRankingExcel(
  originalBuffer,
  allRows.map((r) => ({
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
console.log(`\nExported result Excel to: ${outPath.pathname}`);

console.log(`\nclient_id=${client.id}`);
console.log(`run_id=${run.id}`);

await prisma.$disconnect();
