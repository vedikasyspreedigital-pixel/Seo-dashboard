import { prisma } from "../backend/db/client.js";
import { buildDataForSeoRequest } from "../backend/dataforseo/buildRequest.js";
import { recordAttemptAndApply } from "../backend/dataforseo/recordAttemptAndApply.js";
import { dequeueRow } from "../backend/statemachine/rowTransitions.js";

// Applies the REAL DataForSEO response captured in the previous live test
// to a local test row. No DataForSEO call is made here, no Excel touched --
// Postgres (localhost:5433) only.

const dbUrl = process.env.DATABASE_URL ?? "(not set)";
if (!dbUrl.includes("localhost:5433")) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not point at localhost:5433 (got: ${dbUrl})`,
  );
}

const row = {
  keyword: "cash for cars perth",
  targetUrl: "*cash-for-cars-perth.*",
  locationName: "Australia",
  seDomain: "google.com.au",
  languageName: "English",
};

// Captured verbatim from the approved live API call -- not re-fetched here.
const realResponseBody = {
  version: "0.1.20260806",
  status_code: 20000,
  status_message: "Ok.",
  time: "13.3194 sec.",
  cost: 0.0155,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [
    {
      id: "08200612-3752-0139-0000-f28749f5efcd",
      status_code: 20000,
      status_message: "Ok.",
      time: "13.1717 sec.",
      cost: 0.0155,
      result_count: 1,
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
      data: {
        api: "serp",
        function: "live",
        se: "google",
        se_type: "organic",
        keyword: "cash for cars perth",
        target: "*cash-for-cars-perth.*",
        location_name: "Australia",
        se_domain: "google.com.au",
        language_name: "English",
        device: "desktop",
        os: "windows",
        depth: 100,
      },
      result: [
        {
          keyword: "cash for cars perth",
          type: "organic",
          se_domain: "google.com.au",
          location_code: 2036,
          language_code: "en",
          check_url:
            "https://www.google.com.au/search?q=cash%20for%20cars%20perth&hl=en&gl=AU&ie=UTF-8&uule=w+CAIQIFISCd_Fh2cH_SsrEVITW5WhZ4JT",
          datetime: "2026-08-20 06:12:33 +00:00",
          spell: null,
          refinement_chips: null,
          item_types: [
            "local_pack",
            "organic",
            "people_also_ask",
            "related_searches",
          ],
          se_results_count: 119,
          pages_count: 10,
          items_count: 2,
          items: [
            {
              type: "organic",
              rank_group: 9,
              rank_absolute: 13,
              page: 1,
              domain: "www.cash-for-cars-perth.com.au",
              title: "CASH FOR UNWANTED & DAMAGED ... - Cash For Cars Perth",
              url: "https://www.cash-for-cars-perth.com.au/cash-for-cars/",
              breadcrumb:
                "https://www.cash-for-cars-perth.com.au › cash-for-cars",
            },
            {
              type: "organic",
              rank_group: 33,
              rank_absolute: 40,
              page: 4,
              domain: "www.cash-for-cars-perth.com.au",
              title: "Cash For Cars Perth | Car Removal Perth",
              url: "https://www.cash-for-cars-perth.com.au/",
              breadcrumb: "https://www.cash-for-cars-perth.com.au",
            },
          ],
        },
      ],
    },
  ],
};

const client = await prisma.client.create({
  data: { name: "Demo - Real DataForSEO response applied" },
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
const dbRow = await prisma.rankingRow.create({
  data: {
    runId: run.id,
    rowUid: "demo-real-response-row-uid",
    sourceRowNumber: 2,
    keyword: row.keyword,
    targetUrl: row.targetUrl,
    locationName: row.locationName,
    seDomain: row.seDomain,
    languageName: row.languageName,
    status: "PENDING",
  },
});
await dequeueRow(dbRow.id);

const requestPayload = buildDataForSeoRequest(row);

const {
  row: updatedRow,
  attempt,
  mapped,
} = await recordAttemptAndApply(dbRow.id, {
  requestPayload,
  httpStatus: 200,
  responseBody: realResponseBody,
});

console.log("--- Mapped result (from the real response) ---");
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
  },
]);

console.log(`\nclient_id=${client.id}`);
console.log(`run_id=${run.id}`);
console.log(`row_id=${dbRow.id}`);
console.log("\nCleanup SQL:");
console.log(
  `  DELETE FROM ranking_row_attempts WHERE ranking_row_id = '${dbRow.id}';`,
);
console.log(`  DELETE FROM ranking_rows WHERE id = '${dbRow.id}';`);
console.log(`  DELETE FROM ranking_runs WHERE id = '${run.id}';`);
console.log(`  DELETE FROM clients WHERE id = '${client.id}';`);

await prisma.$disconnect();
