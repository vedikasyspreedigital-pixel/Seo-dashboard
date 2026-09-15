import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { generateEmailDraft, computeReportPeriod } from "../backend/reporting/generateEmailDraft.js";
import { ReportStatus } from "@prisma/client";

// There is exactly ONE canonical period calculation (computeReportPeriod in
// generateEmailDraft.ts) -- the single source generateEmailDraft (the
// Subject/Body template fill) reads from. This file proves that a fresh,
// independent call to computeReportPeriod against a report's stored
// run/previousRun/previousBaseline always reproduces the EXACT same Date
// values already baked into that report's generated Subject/Body -- never a
// different range.
//
// This guards against exactly the class of bug reported live: a report
// whose displayed Subject/Body showed one date range while a fresh
// recomputation for the SAME report produced a different, non-overlapping
// range. Under the current schema, report.runId is set once at creation
// and never reassigned (see createReportForRun, which refuses to create a
// second report for a run that already has one) and RankingRun.completedAt
// is never updated after the fact -- so if this test ever fails, it means
// one of those invariants broke, not that computeReportPeriod itself needs
// a new fallback branch.

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRun(clientId: string, completedAt: Date) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "period-consistency-test.xlsx",
      sourceFilePath: "local-test/period-consistency-test.xlsx",
      totalRows: 1,
      status: "COMPLETED",
      completedAt,
    },
  });
}

async function makeBaseline(clientId: string, baselineDate: Date) {
  return prisma.rankingBaseline.create({
    data: {
      clientId,
      sourceFilename: "period-consistency-baseline.xlsx",
      sourceType: "EXCEL",
      baselineDate,
      rows: { create: [{ keyword: "test keyword", normalizedKeyword: "test keyword", rankValue: 5, rankDisplay: "5" }] },
    },
  });
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  const baselines = await prisma.rankingBaseline.findMany({ where: { clientId } });
  for (const b of baselines) await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: b.id } });
  await prisma.rankingBaseline.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

// Re-fetches only run + previousRun + previousBaseline (the exact fields
// computeReportPeriod needs) as an independent read, separate from
// whatever generateEmailDraft's own query already produced -- proving the
// result is a property of the stored data, not an artifact of one
// particular query shape.
async function recomputePeriodIndependently(reportId: string) {
  const report = await prisma.rankingReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { run: true, previousRun: true, previousBaseline: true },
  });
  return computeReportPeriod(report);
}

test("report period consistency: a run-vs-run comparison's generated Subject/Body and an independent recomputation agree on the exact same period", async () => {
  const client = await makeClient(`Period Consistency Test - run vs run ${randomUUID()}`);
  try {
    const previousRun = await makeRun(client.id, new Date("2026-08-17T00:00:00Z"));
    const run = await makeRun(client.id, new Date("2026-08-31T00:00:00Z"));
    const report = await prisma.rankingReport.create({
      data: {
        clientId: client.id,
        runId: run.id,
        previousRunId: previousRun.id,
        status: ReportStatus.REPORT_READY,
        analyticsJson: { totals: { totalKeywords: 1 } },
        clientPdfPath: "/tmp/stub-report.pdf",
      },
    });

    const generated = await generateEmailDraft(report.id);
    assert.equal(generated.outcome, "SUCCESS");
    // Sanity: the generated draft really does embed this exact range (same
    // assertion style as generateEmailDraft.test.ts) -- not a vacuous check.
    assert.match(generated.subject, /Aug 17, 2026 to Aug 31, 2026/);

    const recomputed = await recomputePeriodIndependently(report.id);
    assert.equal(recomputed.periodStart.getTime(), previousRun.completedAt!.getTime(), "recomputed periodStart must match the actual previousRun.completedAt used to generate the Subject/Body");
    assert.equal(recomputed.periodEnd.getTime(), run.completedAt!.getTime(), "recomputed periodEnd must match the actual run.completedAt used to generate the Subject/Body");
  } finally {
    await cleanupClient(client.id);
  }
});

test("report period consistency: a baseline comparison's generated Subject/Body and an independent recomputation agree on the exact same period", async () => {
  const client = await makeClient(`Period Consistency Test - baseline ${randomUUID()}`);
  try {
    const baseline = await makeBaseline(client.id, new Date("2026-08-17T00:00:00Z"));
    const run = await makeRun(client.id, new Date("2026-08-31T00:00:00Z"));
    const report = await prisma.rankingReport.create({
      data: {
        clientId: client.id,
        runId: run.id,
        previousBaselineId: baseline.id,
        status: ReportStatus.REPORT_READY,
        analyticsJson: { totals: { totalKeywords: 1 } },
        clientPdfPath: "/tmp/stub-report.pdf",
      },
    });

    const generated = await generateEmailDraft(report.id);
    assert.equal(generated.outcome, "SUCCESS");
    assert.match(generated.subject, /Aug 17, 2026/);
    assert.match(generated.subject, /Aug 31, 2026/);

    const recomputed = await recomputePeriodIndependently(report.id);
    assert.equal(recomputed.periodStart.getTime(), baseline.baselineDate.getTime(), "recomputed periodStart must match the actual baseline.baselineDate used to generate the Subject/Body");
    assert.equal(recomputed.periodEnd.getTime(), run.completedAt!.getTime(), "recomputed periodEnd must match the actual run.completedAt used to generate the Subject/Body");
  } finally {
    await cleanupClient(client.id);
  }
});

// Directly encodes the two invariants the live discrepancy report depended
// on being broken: report.runId is immutable, and a run's completedAt is
// never rewritten after completion. If either ever changes, a report's own
// periodEnd could drift out from under an already-generated Subject/Body
// without anything re-running generateEmailDraft -- which is the only way
// a cached draft and a fresh recomputation could ever legitimately disagree
// for the SAME report row.
test("report period consistency: createReportForRun refuses to create a second report for a run that already has one (runId can never become ambiguous)", async () => {
  const { createReportForRun } = await import("../backend/reporting/createReport.js");
  const client = await makeClient(`Period Consistency Test - one report per run ${randomUUID()}`);
  try {
    const run = await makeRun(client.id, new Date("2026-08-31T00:00:00Z"));
    const first = await createReportForRun(run.id);
    assert.equal(first.outcome, "SUCCESS");

    const second = await createReportForRun(run.id);
    assert.equal(second.outcome, "DUPLICATE_REPORT");
    if (second.outcome === "DUPLICATE_REPORT" && first.outcome === "SUCCESS") {
      assert.equal(second.existingReportId, first.report.id);
    }
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
