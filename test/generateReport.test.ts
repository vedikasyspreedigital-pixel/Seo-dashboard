import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../backend/db/client.js";
import { computeRowUid } from "../backend/excel/rowUid.js";
import { generateAnalysisAndReport } from "../backend/reporting/generateReport.js";
import { createMockClaudeAnalyst } from "../backend/reporting/mockClaudeClient.js";
import { ReportStatus } from "@prisma/client";

// Local only: real Postgres (localhost:5433), mocked Claude client. No real
// Claude calls, no ranking worker/state-machine code touched.

const TARGET_URL = "*cash-for-cars-perth.*";
const LOCATION_NAME = "Australia";
const SE_DOMAIN = "google.com.au";
const LANGUAGE_NAME = "English";

async function makeClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function makeRunWithRows(
  clientId: string,
  rows: { keyword: string; rankValue: number | null; rankDisplay: string | null }[],
) {
  const run = await prisma.rankingRun.create({
    data: {
      clientId,
      sourceFilename: "generate-report-test.xlsx",
      sourceFilePath: "local-test/generate-report-test.xlsx",
      totalRows: rows.length,
      status: "COMPLETED",
    },
  });
  let sourceRowNumber = 2;
  for (const row of rows) {
    await prisma.rankingRow.create({
      data: {
        runId: run.id,
        rowUid: computeRowUid({
          clientId,
          keyword: row.keyword,
          targetUrl: TARGET_URL,
          locationName: LOCATION_NAME,
          languageName: LANGUAGE_NAME,
          seDomain: SE_DOMAIN,
        }),
        sourceRowNumber: sourceRowNumber++,
        keyword: row.keyword,
        targetUrl: TARGET_URL,
        locationName: LOCATION_NAME,
        seDomain: SE_DOMAIN,
        languageName: LANGUAGE_NAME,
        status: "COMPLETED",
        rankValue: row.rankValue,
        rankDisplay: row.rankDisplay,
      },
    });
  }
  return run;
}

async function cleanupClient(clientId: string) {
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  for (const run of runs) {
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  }
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  await prisma.clientReportConfig.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
}

test("generateAnalysisAndReport: end to end with a mock Claude client, using real analytics + a real client config", async () => {
  const client = await makeClient(`Generate Report Test - happy path ${randomUUID()}`);
  try {
    const previousRun = await makeRunWithRows(client.id, [
      { keyword: "cash for cars perth", rankValue: 9, rankDisplay: "9" },
      { keyword: "car removal perth", rankValue: 5, rankDisplay: "5" },
    ]);
    const currentRun = await makeRunWithRows(client.id, [
      { keyword: "cash for cars perth", rankValue: 2, rankDisplay: "2" }, // improved
      { keyword: "car removal perth", rankValue: 20, rankDisplay: "20" }, // declined
    ]);

    await prisma.clientReportConfig.create({
      data: {
        clientId: client.id,
        reportTone: "professional",
        sectionsEnabled: ["summary", "wins", "losses"],
        metricsEnabled: ["averageRank", "top10"],
        recipients: ["ops@example.com"],
        reportingFrequency: "weekly",
        templateId: "standard-v1",
      },
    });

    const report = await prisma.rankingReport.create({
      data: { clientId: client.id, runId: currentRun.id, previousRunId: previousRun.id },
    });
    assert.equal(report.status, ReportStatus.PENDING_ANALYSIS);

    const result = await generateAnalysisAndReport(report.id, createMockClaudeAnalyst());
    assert.equal(result.outcome, "SUCCESS");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.REPORT_READY);
    assert.ok(persisted.analyticsJson);
    assert.ok(persisted.analysisJson);
    assert.ok(persisted.reportHtml);
    assert.ok(persisted.reportHtml!.includes(client.name));
    assert.ok(persisted.reportHtml!.includes("cash for cars perth"));
    // The mock's narrative is derived from the real movement data.
    assert.ok((persisted.analysisJson as { notableWins: { keyword: string }[] }).notableWins[0].keyword === "cash for cars perth");
  } finally {
    await cleanupClient(client.id);
  }
});

test("generateAnalysisAndReport: transport-style failure ends in ANALYSIS_FAILED, reportHtml stays null", async () => {
  const client = await makeClient(`Generate Report Test - call error ${randomUUID()}`);
  try {
    const run = await makeRunWithRows(client.id, [{ keyword: "cash for cars perth", rankValue: 9, rankDisplay: "9" }]);
    const report = await prisma.rankingReport.create({ data: { clientId: client.id, runId: run.id } });

    const throwingClient = async () => {
      throw new Error("Claude API unreachable");
    };
    const result = await generateAnalysisAndReport(report.id, throwingClient);
    assert.equal(result.outcome, "CALL_ERROR");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.ANALYSIS_FAILED);
    assert.equal(persisted.lastErrorMessage, "Claude API unreachable");
    assert.equal(persisted.reportHtml, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test("generateAnalysisAndReport: schema-invalid Claude output ends in ANALYSIS_FAILED with a validation error message", async () => {
  const client = await makeClient(`Generate Report Test - validation error ${randomUUID()}`);
  try {
    const run = await makeRunWithRows(client.id, [{ keyword: "cash for cars perth", rankValue: 9, rankDisplay: "9" }]);
    const report = await prisma.rankingReport.create({ data: { clientId: client.id, runId: run.id } });

    const badClient = async () => ({ overallNarrative: "ok" }); // missing required fields
    const result = await generateAnalysisAndReport(report.id, badClient);
    assert.equal(result.outcome, "VALIDATION_ERROR");

    const persisted = await prisma.rankingReport.findUniqueOrThrow({ where: { id: report.id } });
    assert.equal(persisted.status, ReportStatus.ANALYSIS_FAILED);
    assert.ok(persisted.lastErrorMessage && persisted.lastErrorMessage.length > 0);
    assert.equal(persisted.reportHtml, null);
  } finally {
    await cleanupClient(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
