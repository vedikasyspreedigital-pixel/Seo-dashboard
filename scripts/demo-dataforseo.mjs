import { prisma } from "../backend/db/client.js";
import { buildDataForSeoRequest } from "../backend/dataforseo/buildRequest.js";
import { recordAttemptAndApply } from "../backend/dataforseo/recordAttemptAndApply.js";
import { dequeueRow } from "../backend/statemachine/rowTransitions.js";

// Demo only: builds the request payload for the locked cash-for-cars-perth
// row, applies a hand-built MOCK DataForSEO response (no network call is
// made anywhere in this file), and prints exactly what lands in Postgres.

const dbUrl = process.env.DATABASE_URL ?? "(not set)";
if (!dbUrl.includes("localhost:5433")) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not point at localhost:5433 (got: ${dbUrl})`,
  );
}
console.log(`Connected to: ${dbUrl}\n`);

const client = await prisma.client.create({
  data: { name: "Demo - DataForSEO mapping" },
});
const run = await prisma.rankingRun.create({
  data: {
    clientId: client.id,
    sourceFilename: "cash-for-cars-perth.xlsx",
    sourceFilePath: "local-demo/cash-for-cars-perth.xlsx",
    totalRows: 1,
    status: "PROCESSING",
  },
});
const row = await prisma.rankingRow.create({
  data: {
    runId: run.id,
    rowUid: "demo-row-uid",
    sourceRowNumber: 2,
    keyword: "cash for cars perth",
    targetUrl: "*cash-for-cars-perth.*",
    locationName: "Australia",
    seDomain: "google.com.au",
    languageName: "English",
    status: "PENDING",
  },
});
await dequeueRow(row.id);

const requestPayload = buildDataForSeoRequest(row);
console.log("--- Exact DataForSEO request payload ---");
console.log(JSON.stringify(requestPayload, null, 2));

// Hand-built MOCK response -- shaped exactly like a real DataForSEO Live
// Advanced Organic response. Nothing here comes from a live API call.
const mockResponse = {
  status_code: 20000,
  status_message: "Ok.",
  tasks: [
    {
      status_code: 20000,
      status_message: "Ok.",
      result: [
        {
          keyword: "cash for cars perth",
          type: "organic",
          se_domain: "google.com.au",
          location_code: 2036,
          language_code: "en",
          items: [
            {
              type: "organic",
              rank_group: 8,
              rank_absolute: 9,
              page: 1,
              domain: "cash-for-cars-perth.com.au",
              title: "Cash For Cars Perth | We Buy Any Car",
              description: "Get an instant quote and same-day pickup.",
              url: "https://www.cash-for-cars-perth.com.au/",
              breadcrumb: "cash-for-cars-perth.com.au",
            },
          ],
        },
      ],
    },
  ],
};
console.log("\n--- Mocked DataForSEO response (no live API call made) ---");
console.log(JSON.stringify(mockResponse, null, 2));

const {
  row: updatedRow,
  attempt,
  mapped,
} = await recordAttemptAndApply(row.id, {
  requestPayload,
  httpStatus: 200,
  responseBody: mockResponse,
});

console.log("\n--- Mapped result ---");
console.log(mapped);

console.log(
  "\n--- Resulting ranking_rows row in Postgres (localhost:5433) ---",
);
console.table([
  {
    status: updatedRow.status,
    rank_value: updatedRow.rankValue,
    rank_display: updatedRow.rankDisplay,
    ranking_url: updatedRow.rankingUrl,
    retry_count: updatedRow.retryCount,
    last_attempt_id: updatedRow.lastAttemptId,
  },
]);

console.log("--- Resulting ranking_row_attempts row ---");
console.table([
  {
    attempt_number: attempt.attemptNumber,
    outcome: attempt.outcome,
    dataforseo_status_code: attempt.dataforseoStatusCode,
    mapped_rank_value: attempt.mappedRankValue,
    mapped_ranking_url: attempt.mappedRankingUrl,
  },
]);

console.log(`\nclient_id=${client.id}`);
console.log(`run_id=${run.id}`);
console.log(`row_id=${row.id}`);
console.log("\nCleanup SQL:");
console.log(
  `  DELETE FROM ranking_row_attempts WHERE ranking_row_id = '${row.id}';`,
);
console.log(`  DELETE FROM ranking_rows WHERE id = '${row.id}';`);
console.log(`  DELETE FROM ranking_runs WHERE id = '${run.id}';`);
console.log(`  DELETE FROM clients WHERE id = '${client.id}';`);

await prisma.$disconnect();
