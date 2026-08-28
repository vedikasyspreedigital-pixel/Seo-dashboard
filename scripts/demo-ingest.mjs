import { prisma } from "../backend/db/client.js";
import { ingestExcelRun } from "../backend/runs/ingestExcelRun.js";
import { buildSampleWorkbook } from "./create-sample-excel.mjs";

// Manual, visible demo of the ingest path -- inserts real rows into the
// local dev container and prints them back, unlike test/db.test.mjs which
// cleans up after itself. Safe to re-run; each call makes a new Client/Run.

const dbUrl = process.env.DATABASE_URL ?? "(not set)";
console.log(`Connected to: ${dbUrl}`);
if (!dbUrl.includes("localhost:5433")) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not point at localhost:5433 (got: ${dbUrl})`,
  );
}

const client = await prisma.client.create({
  data: { name: "Demo - Cash For Cars Perth" },
});
console.log(`\nCreated client: ${client.id} (${client.name})`);

const buffer = await (await buildSampleWorkbook()).xlsx.writeBuffer();

const { run, insertedRowCount, rowErrors, totalDataRows } =
  await ingestExcelRun({
    clientId: client.id,
    sourceFilename: "cash-for-cars-perth.xlsx",
    sourceFilePath: "local-demo/cash-for-cars-perth.xlsx",
    fileBuffer: buffer,
  });

console.log(`\nCreated ranking_run: ${run.id}`);
console.log(`  status=${run.status} totalRows=${run.totalRows}`);
console.log(
  `  parsed ${totalDataRows} data rows -> inserted ${insertedRowCount}, ${rowErrors.length} rejected`,
);

if (rowErrors.length > 0) {
  console.log("\nRejected rows:");
  for (const err of rowErrors) {
    console.log(`  row ${err.sourceRowNumber}: ${err.reason}`);
  }
}

const rows = await prisma.rankingRow.findMany({
  where: { runId: run.id },
  orderBy: { sourceRowNumber: "asc" },
});

console.log("\nInserted ranking_rows:");
console.table(
  rows.map((r) => ({
    row: r.sourceRowNumber,
    keyword: r.keyword,
    target_url: r.targetUrl,
    location: r.locationName,
    se_domain: r.seDomain,
    status: r.status,
    rank_value: r.rankValue,
    rank_display: r.rankDisplay,
    ranking_url: r.rankingUrl,
  })),
);

console.log(`\nclient_id=${client.id}`);
console.log(`run_id=${run.id}`);
console.log(
  "\nLeft in place in the local container for inspection. To remove:",
);
console.log(`  DELETE FROM ranking_rows WHERE run_id = '${run.id}';`);
console.log(`  DELETE FROM ranking_runs WHERE id = '${run.id}';`);
console.log(`  DELETE FROM clients WHERE id = '${client.id}';`);

await prisma.$disconnect();
