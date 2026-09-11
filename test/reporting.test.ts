import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { computeRunAnalytics } from "../backend/reporting/computeRunAnalytics.js";
import { computeRowUid } from "../backend/excel/rowUid.js";

// Local only: real Postgres (localhost:5433). Read-only against ranking_rows
// -- no ranking worker/state-machine code is touched or imported here.

const LOCATION_NAME = "Australia";
const SE_DOMAIN = "google.com.au";
const LANGUAGE_NAME = "English";
const TARGET_URL = "*cash-for-cars-perth.*";

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string, sourceRowNumberStart = 2) {
  const run = await prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "analytics-test.xlsx",
      sourceFilePath: "local-test/analytics-test.xlsx",
      totalRows: 0,
      status: "COMPLETED",
    },
  });
  return { run, nextRowNumber: sourceRowNumberStart };
}

interface RowSpec {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
}

async function makeRows(clientId: string, runId: string, specs: RowSpec[]) {
  let sourceRowNumber = 2;
  for (const spec of specs) {
    await prisma.rankingRow.create({
      data: {
        runId,
        rowUid: computeRowUid({
          clientId,
          keyword: spec.keyword,
          targetUrl: TARGET_URL,
          locationName: LOCATION_NAME,
          languageName: LANGUAGE_NAME,
          seDomain: SE_DOMAIN,
        }),
        sourceRowNumber: sourceRowNumber++,
        keyword: spec.keyword,
        targetUrl: TARGET_URL,
        locationName: LOCATION_NAME,
        seDomain: SE_DOMAIN,
        languageName: LANGUAGE_NAME,
        status: "COMPLETED",
        rankValue: spec.rankValue,
        rankDisplay: spec.rankDisplay,
      },
    });
  }
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) {
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("totals: total count, average rank, top3, top10, Not in 100 -- computed correctly on a single run", async () => {
  const client = await makeClient(`Analytics Test - totals ${randomUUID()}`);
  try {
    const { run } = await makeRun(client.id);
    await makeRows(client.id, run.id, [
      { keyword: "top3-kw", rankValue: 1, rankDisplay: "1" },
      { keyword: "top10-kw", rankValue: 9, rankDisplay: "9" },
      { keyword: "mid-kw", rankValue: 40, rankDisplay: "40" },
      { keyword: "notin100-a", rankValue: null, rankDisplay: "Not in 100" },
      { keyword: "notin100-b", rankValue: null, rankDisplay: "Not in 100" },
    ]);

    const analytics = await computeRunAnalytics(run.id);

    assert.equal(analytics.totals.totalKeywords, 5);
    assert.equal(analytics.totals.averageRank, 16.7); // (1+9+40)/3 = 16.666... -> 16.7
    assert.equal(analytics.totals.top3Count, 1);
    assert.equal(analytics.totals.top10Count, 2); // 1 and 9
    assert.equal(analytics.totals.notIn100Count, 2);
  } finally {
    await cleanupClient(client.id);
  }
});

test("totals: a run with zero ranked rows has averageRank null, not NaN or 0", async () => {
  const client = await makeClient(`Analytics Test - all not-in-100 ${randomUUID()}`);
  try {
    const { run } = await makeRun(client.id);
    await makeRows(client.id, run.id, [
      { keyword: "a", rankValue: null, rankDisplay: "Not in 100" },
      { keyword: "b", rankValue: null, rankDisplay: "Not in 100" },
    ]);

    const analytics = await computeRunAnalytics(run.id);
    assert.equal(analytics.totals.averageRank, null);
    assert.equal(analytics.totals.top3Count, 0);
    assert.equal(analytics.totals.top10Count, 0);
    assert.equal(analytics.totals.notIn100Count, 2);
  } finally {
    await cleanupClient(client.id);
  }
});

test("without a previousRunId (a brand-new client's first run): every row is newlyTracked, not silently dropped", async () => {
  // Regression test: computeRunAnalytics used to skip computeMovements
  // entirely when there was no previousRunId, leaving ALL movement arrays
  // empty -- which meant generateClientReportPdf's buildRowsAndSummary
  // (which only ever reads from analytics.movements, never raw rows) had
  // nothing to render, producing an empty report for exactly the case
  // that matters most: a client's very first-ever run.
  const client = await makeClient(`Analytics Test - no baseline ${randomUUID()}`);
  try {
    const { run } = await makeRun(client.id);
    await makeRows(client.id, run.id, [
      { keyword: "solo-kw", rankValue: 5, rankDisplay: "5" },
      { keyword: "not-in-100-kw", rankValue: null, rankDisplay: "Not in 100" },
    ]);

    const analytics = await computeRunAnalytics(run.id);

    assert.equal(analytics.previousRunId, null);
    assert.equal(analytics.previousTotals, null, "no previous run means no previous totals to summarize");
    assert.equal(analytics.totals.totalKeywords, 2);
    assert.deepEqual(analytics.movements.improved, []);
    assert.deepEqual(analytics.movements.declined, []);
    assert.deepEqual(analytics.movements.unchanged, []);
    assert.equal(analytics.movements.newlyTracked.length, 2, "every current-run row must appear as newlyTracked when there's no previous side at all");
    assert.deepEqual(
      analytics.movements.newlyTracked.map((m) => [m.keyword, m.currentRank]).sort(),
      [["not-in-100-kw", null], ["solo-kw", 5]],
    );
  } finally {
    await cleanupClient(client.id);
  }
});

test("movements: improved / declined / unchanged / newlyTracked, including Not-in-100 transitions", async () => {
  const client = await makeClient(`Analytics Test - movements ${randomUUID()}`);
  try {
    const { run: previousRun } = await makeRun(client.id);
    await makeRows(client.id, previousRun.id, [
      { keyword: "top3-kw", rankValue: 2, rankDisplay: "2" },
      { keyword: "top10-kw", rankValue: 8, rankDisplay: "8" },
      { keyword: "notin100-kw", rankValue: null, rankDisplay: "Not in 100" },
      { keyword: "declining-kw", rankValue: 5, rankDisplay: "5" },
      { keyword: "improving-kw", rankValue: 50, rankDisplay: "50" },
      { keyword: "steady-kw", rankValue: 20, rankDisplay: "20" },
      { keyword: "dropping-out-kw", rankValue: 30, rankDisplay: "30" },
      { keyword: "entering-kw", rankValue: null, rankDisplay: "Not in 100" },
    ]);

    const { run: currentRun } = await makeRun(client.id);
    await makeRows(client.id, currentRun.id, [
      { keyword: "top3-kw", rankValue: 1, rankDisplay: "1" }, // improved 2->1
      { keyword: "top10-kw", rankValue: 9, rankDisplay: "9" }, // declined 8->9
      { keyword: "notin100-kw", rankValue: null, rankDisplay: "Not in 100" }, // unchanged null->null
      { keyword: "declining-kw", rankValue: 15, rankDisplay: "15" }, // declined 5->15
      { keyword: "improving-kw", rankValue: 10, rankDisplay: "10" }, // improved 50->10
      { keyword: "steady-kw", rankValue: 20, rankDisplay: "20" }, // unchanged 20->20
      { keyword: "dropping-out-kw", rankValue: null, rankDisplay: "Not in 100" }, // declined 30->null
      { keyword: "entering-kw", rankValue: 40, rankDisplay: "40" }, // improved null->40
      { keyword: "brand-new-kw", rankValue: 5, rankDisplay: "5" }, // newlyTracked, no previous row
    ]);

    const analytics = await computeRunAnalytics(currentRun.id, previousRun.id);

    assert.equal(analytics.previousRunId, previousRun.id);

    const byKeyword = <T extends { keyword: string }>(list: T[], kw: string) => list.find((x) => x.keyword === kw);

    assert.equal(analytics.movements.improved.length, 3);
    assert.ok(byKeyword(analytics.movements.improved, "top3-kw"));
    assert.equal(byKeyword(analytics.movements.improved, "top3-kw")?.delta, 1);
    assert.ok(byKeyword(analytics.movements.improved, "improving-kw"));
    assert.equal(byKeyword(analytics.movements.improved, "improving-kw")?.delta, 40);
    assert.ok(byKeyword(analytics.movements.improved, "entering-kw"));
    assert.equal(byKeyword(analytics.movements.improved, "entering-kw")?.delta, null); // null -> numeric, delta undefined

    assert.equal(analytics.movements.declined.length, 3);
    assert.ok(byKeyword(analytics.movements.declined, "top10-kw"));
    assert.equal(byKeyword(analytics.movements.declined, "top10-kw")?.delta, -1);
    assert.ok(byKeyword(analytics.movements.declined, "declining-kw"));
    assert.equal(byKeyword(analytics.movements.declined, "declining-kw")?.delta, -10);
    assert.ok(byKeyword(analytics.movements.declined, "dropping-out-kw"));
    assert.equal(byKeyword(analytics.movements.declined, "dropping-out-kw")?.delta, null); // numeric -> null

    assert.equal(analytics.movements.unchanged.length, 2);
    assert.ok(byKeyword(analytics.movements.unchanged, "notin100-kw"));
    assert.ok(byKeyword(analytics.movements.unchanged, "steady-kw"));
    assert.equal(byKeyword(analytics.movements.unchanged, "steady-kw")?.delta, 0);

    assert.equal(analytics.movements.newlyTracked.length, 1);
    assert.equal(analytics.movements.newlyTracked[0].keyword, "brand-new-kw");
    assert.equal(analytics.movements.newlyTracked[0].currentRank, 5);

    // Sanity: every current row landed in exactly one bucket.
    const totalBucketed =
      analytics.movements.improved.length +
      analytics.movements.declined.length +
      analytics.movements.unchanged.length +
      analytics.movements.newlyTracked.length;
    assert.equal(totalBucketed, 9);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
