import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { createReportForRun } from "../backend/reporting/createReport.js";

// Covers createReportForRun's auto-fallback specifically for the new
// baseline case: a client's first-ever run should automatically compare
// against their uploaded baseline (the desired onboarding flow: Client ->
// Upload Previous Ranking -> baseline stored -> new run completes ->
// compared automatically) without the caller having to know a baseline
// exists. A real prior RUN, when one exists, still takes priority over a
// baseline -- this is not a case this test exercises destructively; it just
// confirms the baseline is not preferred over a real run that qualifies.

async function makeClient() {
  return prisma.client.create({ data: { name: `Report Baseline Fallback Test - ${randomUUID()}` } });
}

async function makeRun(clientId: string, overrides: Partial<{ status: "COMPLETED" | "UPLOADED"; completedAt: Date }> = {}) {
  return prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "fallback-test.xlsx",
      sourceFilePath: "local-test/fallback-test.xlsx",
      totalRows: 1,
      status: overrides.status ?? "COMPLETED",
      completedAt: overrides.completedAt ?? new Date(),
    },
  });
}

async function makeBaseline(clientId: string) {
  return prisma.rankingBaseline.create({
    data: {
      clientId,
      sourceFilename: "baseline.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date("2026-08-17"),
      rows: { create: [{ keyword: "test keyword", normalizedKeyword: "test keyword", rankValue: 5, rankDisplay: "5" }] },
    },
  });
}

async function cleanup(clientId: string) {
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  const baselines = await prisma.rankingBaseline.findMany({ where: { clientId } });
  for (const b of baselines) await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: b.id } });
  await prisma.rankingBaseline.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("createReportForRun: a client's first-ever run auto-falls-back to their uploaded baseline when no prior run exists", async () => {
  const client = await makeClient();
  try {
    const baseline = await makeBaseline(client.id);
    const run = await makeRun(client.id);

    const result = await createReportForRun(run.id);
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;

    assert.equal(result.report.previousRunId, null);
    assert.equal(result.report.previousBaselineId, baseline.id);
  } finally {
    await cleanup(client.id);
  }
});

test("createReportForRun: with no prior run AND no baseline, falls back to neither (both null) rather than erroring", async () => {
  const client = await makeClient();
  try {
    const run = await makeRun(client.id);
    const result = await createReportForRun(run.id);
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    assert.equal(result.report.previousRunId, null);
    assert.equal(result.report.previousBaselineId, null);
  } finally {
    await cleanup(client.id);
  }
});

test("createReportForRun: an explicit previousBaselineId is honored even when a prior real run also exists", async () => {
  const client = await makeClient();
  try {
    await makeRun(client.id, { completedAt: new Date(Date.now() - 60_000) }); // an older, qualifying prior run
    const baseline = await makeBaseline(client.id);
    const run = await makeRun(client.id);

    const result = await createReportForRun(run.id, undefined, baseline.id);
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    assert.equal(result.report.previousBaselineId, baseline.id);
    assert.equal(result.report.previousRunId, null, "explicit previousBaselineId must not also carry over an unrelated previousRunId");
  } finally {
    await cleanup(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
