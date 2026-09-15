import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { compareRunToBaseline } from "../backend/baselines/compareRunToBaseline.js";
import { normalizeKeyword } from "../backend/baselines/normalizeKeyword.js";

// Real end-to-end coverage (against the actual local Postgres) for the
// baseline comparison engine, mirroring computeRunAnalytics.test.mjs-style
// integration tests but through an imported baseline instead of a second
// real run -- specifically covering the transitions the feature was asked
// to handle: ranked->ranked, Not-in-100->ranked, ranked->Not-in-100,
// missing on either side, and duplicate normalized keywords.

async function makeClient() {
  return prisma.client.create({ data: { name: `Baseline Compare Test - ${randomUUID()}` } });
}

async function makeRun(clientId: string) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "compare-test.xlsx",
      sourceFilePath: "local-test/compare-test.xlsx",
      totalRows: 0,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
}

async function makeRow(runId: string, keyword: string, rankValue: number | null, rankDisplay: string | null) {
  return prisma.rankingRow.create({
    data: {
      runId,
      rowUid: randomUUID(),
      sourceRowNumber: 1,
      keyword,
      targetUrl: "*example.*",
      locationName: "United Arab Emirates",
      seDomain: "google.ae",
      languageName: "English",
      status: "COMPLETED",
      rankValue,
      rankDisplay,
    },
  });
}

async function makeBaseline(clientId: string, rows: { keyword: string; rankValue: number | null; rankDisplay: string | null }[]) {
  return prisma.rankingBaseline.create({
    data: {
      clientId,
      sourceFilename: "baseline-test.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date("2026-08-17"),
      rows: {
        create: rows.map((r) => ({
          keyword: r.keyword,
          normalizedKeyword: normalizeKeyword(r.keyword),
          rankValue: r.rankValue,
          rankDisplay: r.rankDisplay,
        })),
      },
    },
  });
}

async function cleanup(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  const baselines = await prisma.rankingBaseline.findMany({ where: { clientId } });
  for (const b of baselines) await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: b.id } });
  await prisma.rankingBaseline.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("compareRunToBaseline: handles ranked->ranked, Not-in-100->ranked, ranked->Not-in-100, and missing-on-either-side keywords", async () => {
  const client = await makeClient();
  try {
    const baseline = await makeBaseline(client.id, [
      { keyword: "car accessories abu dhabi", rankValue: 3, rankDisplay: "3" }, // ranked -> ranked (improved)
      { keyword: "car wrapping abu dhabi", rankValue: null, rankDisplay: "Not in 100" }, // Not-in-100 -> ranked
      { keyword: "car tinting abu dhabi", rankValue: 26, rankDisplay: "26" }, // ranked -> Not-in-100
      { keyword: "keyword only in baseline", rankValue: 10, rankDisplay: "10" }, // missing from the current run entirely
    ]);
    const run = await makeRun(client.id);
    await makeRow(run.id, "car accessories abu dhabi", 1, "1"); // improved from 3 to 1
    await makeRow(run.id, "car wrapping abu dhabi", 27, "27"); // now ranked, wasn't before
    await makeRow(run.id, "car tinting abu dhabi", null, "Not in 100"); // dropped out of the top 100
    await makeRow(run.id, "keyword only in current run", 5, "5"); // newly tracked, no baseline history

    const analytics = await compareRunToBaseline(run.id, baseline.id);

    assert.equal(analytics.previousRunId, null);
    assert.equal(analytics.hasComparison, true, "a baseline comparison always has something to compare against");
    assert.equal(analytics.totals.totalKeywords, 4);
    // 3, not 4: previousTotals only counts baseline rows that actually
    // matched a current keyword ("keyword only in baseline" matches
    // nothing in the current run, so it must not count toward -- or
    // silently inflate/skew -- this comparison's previous-side totals).
    assert.equal(analytics.previousTotals?.totalKeywords, 3);

    const improved = analytics.movements.improved.find((m) => m.keyword === "car accessories abu dhabi");
    assert.ok(improved);
    assert.equal(improved!.previousRank, 3);
    assert.equal(improved!.currentRank, 1);

    const enteredRanked = analytics.movements.improved.find((m) => m.keyword === "car wrapping abu dhabi");
    assert.ok(enteredRanked, "Not-in-100 -> ranked must classify as improved, not unchanged");
    assert.equal(enteredRanked!.previousRank, null);
    assert.equal(enteredRanked!.currentRank, 27);

    const droppedOut = analytics.movements.declined.find((m) => m.keyword === "car tinting abu dhabi");
    assert.ok(droppedOut, "ranked -> Not-in-100 must classify as declined, not unchanged");
    assert.equal(droppedOut!.previousRank, 26);
    assert.equal(droppedOut!.currentRank, null);

    const newlyTracked = analytics.movements.newlyTracked.find((m) => m.keyword === "keyword only in current run");
    assert.ok(newlyTracked, "a keyword with no baseline row at all must land in newlyTracked, not crash or get silently dropped");

    // "keyword only in baseline" (present in the baseline, absent from the
    // current run) must not appear in any current-side movement bucket --
    // computeMovements only iterates the CURRENT run's rows, matching the
    // pre-existing run-to-run comparison's own behavior (not a new gap
    // introduced by baseline comparison).
    const allCurrentKeywords = [
      ...analytics.movements.improved,
      ...analytics.movements.declined,
      ...analytics.movements.unchanged,
      ...analytics.movements.newlyTracked,
    ].map((m) => m.keyword);
    assert.ok(!allCurrentKeywords.includes("keyword only in baseline"));
  } finally {
    await cleanup(client.id);
  }
});

test("compareRunToBaseline: matches purely by normalized keyword (case/whitespace-insensitive), not by any other field", async () => {
  const client = await makeClient();
  try {
    const baseline = await makeBaseline(client.id, [{ keyword: "  Car Accessories   Abu Dhabi ", rankValue: 5, rankDisplay: "5" }]);
    const run = await makeRun(client.id);
    await makeRow(run.id, "car accessories abu dhabi", 2, "2");

    const analytics = await compareRunToBaseline(run.id, baseline.id);
    const improved = analytics.movements.improved.find((m) => m.keyword === "car accessories abu dhabi");
    assert.ok(improved, "differing case/whitespace between the baseline and the run must still match");
    assert.equal(improved!.previousRank, 5);
  } finally {
    await cleanup(client.id);
  }
});

test("compareRunToBaseline: duplicate normalized keywords on the baseline side collapse to one entry (last-write-wins), same pre-existing limitation as rowUid-based matching", async () => {
  const client = await makeClient();
  try {
    const baseline = await makeBaseline(client.id, [
      { keyword: "car audio abu dhabi", rankValue: 40, rankDisplay: "40" },
      { keyword: "car audio abu dhabi", rankValue: 4, rankDisplay: "4" },
    ]);
    const run = await makeRun(client.id);
    await makeRow(run.id, "car audio abu dhabi", 4, "4");

    const analytics = await compareRunToBaseline(run.id, baseline.id);
    // Whichever baseline row wins, the result must be internally consistent
    // (either "unchanged" if 4 won, or "improved" if 40 won) -- it must not
    // throw or silently drop the row.
    const all = [...analytics.movements.improved, ...analytics.movements.unchanged, ...analytics.movements.declined];
    const match = all.find((m) => m.keyword === "car audio abu dhabi");
    assert.ok(match);
  } finally {
    await cleanup(client.id);
  }
});

// Regression coverage for the clarified rule (confirmed against a real
// production report: client "demo testing", run keywords compared
// against an unrelated "Emirates Sound" baseline of 35 car-accessories
// keywords -- zero overlap, yet the PDF still showed a real-looking
// "Previous Average Rank: 12.2" borrowed from that unrelated baseline's
// own average). A comparison exists ONLY when at least one keyword
// actually matches -- zero overlap must be indistinguishable from having
// selected no baseline at all: no previous rank, no movement, no
// previous average, current rank only.
test("zero-match: a baseline sharing NO keywords with the run behaves exactly like no comparison at all", async () => {
  const client = await makeClient();
  try {
    const baseline = await makeBaseline(client.id, [
      { keyword: "unrelated keyword one", rankValue: 3, rankDisplay: "3" },
      { keyword: "unrelated keyword two", rankValue: 21, rankDisplay: "21" },
    ]); // real average of these two is 12 -- must never leak into the current report
    const run = await makeRun(client.id);
    await makeRow(run.id, "executive coaching", 5, "5");
    await makeRow(run.id, "team building activities", null, "Not in 100");

    const analytics = await compareRunToBaseline(run.id, baseline.id);

    assert.equal(analytics.hasComparison, false, "zero keyword overlap must read as no comparison, not as 'compared, nothing matched'");
    assert.equal(analytics.previousTotals, null, "no previous data to summarize -- null outright, same as no baseline at all");
    assert.deepEqual(analytics.movements.improved, []);
    assert.deepEqual(analytics.movements.declined, []);
    assert.deepEqual(analytics.movements.unchanged, []);
    assert.equal(analytics.movements.newlyTracked.length, 2, "every current keyword is newlyTracked -- none of them matched anything in the unrelated baseline");
    // Current rank must still be shown regardless of comparison outcome.
    assert.equal(analytics.totals.totalKeywords, 2);
    assert.equal(analytics.totals.averageRank, 5);
  } finally {
    await cleanup(client.id);
  }
});

// Full match: every current keyword has a corresponding baseline row.
test("full-match: every current keyword has a matching baseline row -- previousTotals reflects the entire matched set", async () => {
  const client = await makeClient();
  try {
    const baseline = await makeBaseline(client.id, [
      { keyword: "kw-a", rankValue: 10, rankDisplay: "10" },
      { keyword: "kw-b", rankValue: 20, rankDisplay: "20" },
    ]);
    const run = await makeRun(client.id);
    await makeRow(run.id, "kw-a", 5, "5");
    await makeRow(run.id, "kw-b", 20, "20");

    const analytics = await compareRunToBaseline(run.id, baseline.id);

    assert.equal(analytics.hasComparison, true);
    assert.equal(analytics.previousTotals?.totalKeywords, 2);
    assert.equal(analytics.previousTotals?.averageRank, 15); // (10+20)/2
    assert.equal(analytics.movements.newlyTracked.length, 0, "nothing is newlyTracked when every current keyword matched");
    assert.equal(analytics.movements.improved.length, 1);
    assert.equal(analytics.movements.unchanged.length, 1);
  } finally {
    await cleanup(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
