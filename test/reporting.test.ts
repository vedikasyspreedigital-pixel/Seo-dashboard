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
    assert.equal(analytics.hasComparison, false, "no previous run at all means this report has nothing to compare against");
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
    assert.equal(analytics.hasComparison, true);

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

// Regression coverage for the clarified rule: a comparison exists ONLY
// when at least one keyword actually matches between the two sides --
// selecting a previous run that shares nothing at all with the current
// keywords (wrong run, unrelated file, cross-client test data, etc.) must
// be indistinguishable from having selected no comparison at all: no
// previous rank, no movement, no previous average, no "entered/dropped
// out of top 100" -- current rank only. Real report that surfaced this:
// a run with 3 real keywords compared against an unrelated previous run
// still showed a real-looking "Previous Average Rank" borrowed from the
// unrelated run's own average.
test("zero-match: a previous run sharing NO keywords with the current run behaves exactly like no comparison at all", async () => {
  const client = await makeClient(`Analytics Test - zero match ${randomUUID()}`);
  try {
    const { run: previousRun } = await makeRun(client.id);
    await makeRows(client.id, previousRun.id, [
      { keyword: "unrelated-kw-a", rankValue: 3, rankDisplay: "3" },
      { keyword: "unrelated-kw-b", rankValue: 21, rankDisplay: "21" },
      { keyword: "unrelated-kw-c", rankValue: 12, rankDisplay: "12" },
    ]); // real average of these three is 12 -- must never leak into the current report

    const { run: currentRun } = await makeRun(client.id);
    await makeRows(client.id, currentRun.id, [
      { keyword: "executive coaching", rankValue: 5, rankDisplay: "5" },
      { keyword: "team building activities", rankValue: null, rankDisplay: "Not in 100" },
    ]);

    const analytics = await computeRunAnalytics(currentRun.id, previousRun.id);

    assert.equal(analytics.hasComparison, false, "zero keyword overlap must read as no comparison, not as 'compared, nothing matched'");
    assert.equal(analytics.previousTotals, null, "no previous data to summarize -- not an object with averageRank: null, null outright, same as no previous run at all");
    assert.deepEqual(analytics.movements.improved, [], "no movement language when nothing matched");
    assert.deepEqual(analytics.movements.declined, []);
    assert.deepEqual(analytics.movements.unchanged, []);
    assert.equal(analytics.movements.newlyTracked.length, 2, "every current keyword is newlyTracked -- none of them matched anything in the unrelated previous run");
    // Current rank must still be shown regardless of comparison outcome.
    assert.equal(analytics.totals.totalKeywords, 2);
    assert.equal(analytics.totals.averageRank, 5);
    assert.deepEqual(
      analytics.movements.newlyTracked.map((m) => [m.keyword, m.currentRank]).sort(),
      [["executive coaching", 5], ["team building activities", null]],
    );
  } finally {
    await cleanupClient(client.id);
  }
});

// Partial match: only the keywords that actually appear on both sides
// participate in the comparison -- every unmatched keyword on either side
// (baseline/previous-run noise, or a current keyword with no history) is
// ignored for comparison purposes, never averaged in and never blocking
// the comparison from existing.
test("partial-match: only the keywords present on both sides are compared; unmatched keywords on either side are ignored", async () => {
  const client = await makeClient(`Analytics Test - partial match ${randomUUID()}`);
  try {
    const { run: previousRun } = await makeRun(client.id);
    await makeRows(client.id, previousRun.id, [
      { keyword: "shared-kw", rankValue: 10, rankDisplay: "10" }, // matches current -> counted
      { keyword: "unrelated-kw", rankValue: 90, rankDisplay: "90" }, // no match in current -> must be excluded
    ]);

    const { run: currentRun } = await makeRun(client.id);
    await makeRows(client.id, currentRun.id, [
      { keyword: "shared-kw", rankValue: 8, rankDisplay: "8" }, // matches -> real comparison
      { keyword: "current-only-kw", rankValue: 50, rankDisplay: "50" }, // no match in previous -> newlyTracked, ignored for the average
    ]);

    const analytics = await computeRunAnalytics(currentRun.id, previousRun.id);

    assert.equal(analytics.hasComparison, true, "at least one real match exists -- this IS a genuine comparison");
    assert.equal(analytics.previousTotals?.totalKeywords, 1, "only the matched row counts, not the unrelated one");
    assert.equal(analytics.previousTotals?.averageRank, 10, "must be shared-kw's own previous rank (10), not (10+90)/2 = 50");
    assert.equal(analytics.movements.improved.length, 1);
    assert.equal(analytics.movements.improved[0].keyword, "shared-kw");
    assert.equal(analytics.movements.newlyTracked.length, 1);
    assert.equal(analytics.movements.newlyTracked[0].keyword, "current-only-kw");
  } finally {
    await cleanupClient(client.id);
  }
});

// Full match: every current keyword has a corresponding previous row --
// the ordinary case, previousTotals reflects the whole previous set
// exactly because every one of its rows matched something current.
test("full-match: every current keyword has a matching previous row -- previousTotals reflects the entire matched set", async () => {
  const client = await makeClient(`Analytics Test - full match ${randomUUID()}`);
  try {
    const { run: previousRun } = await makeRun(client.id);
    await makeRows(client.id, previousRun.id, [
      { keyword: "kw-a", rankValue: 10, rankDisplay: "10" },
      { keyword: "kw-b", rankValue: 20, rankDisplay: "20" },
    ]);

    const { run: currentRun } = await makeRun(client.id);
    await makeRows(client.id, currentRun.id, [
      { keyword: "kw-a", rankValue: 5, rankDisplay: "5" },
      { keyword: "kw-b", rankValue: 20, rankDisplay: "20" },
    ]);

    const analytics = await computeRunAnalytics(currentRun.id, previousRun.id);

    assert.equal(analytics.hasComparison, true);
    assert.equal(analytics.previousTotals?.totalKeywords, 2);
    assert.equal(analytics.previousTotals?.averageRank, 15); // (10+20)/2
    assert.equal(analytics.movements.newlyTracked.length, 0, "nothing is newlyTracked when every current keyword matched");
    assert.equal(analytics.movements.improved.length, 1);
    assert.equal(analytics.movements.unchanged.length, 1);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
