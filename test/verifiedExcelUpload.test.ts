import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { ingestExcelRun } from "../backend/runs/ingestExcelRun.js";
import { processVerifiedExcelUpload } from "../backend/reporting/processVerifiedExcelUpload.js";
import { COLUMN_HEADERS } from "../backend/excel/parser.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// This run's status/rows are seeded directly (not via the real DataForSEO
// worker), so this callback should never actually be invoked -- the HTTP
// test below never calls /start.
const unusedCallDataForSeo: CallDataForSeoFn = async () => {
  throw new Error("callDataForSeo should not be invoked by this test");
};

// Covers the new automatic pipeline end to end: upload a verified Excel for
// a completed run -> apply corrections -> compare against the client's
// previous verified Excel (a RankingBaseline) -> build the PDF -> draft the
// email -> only then promote this upload to the client's new baseline. This
// is the primary UI path now (POST /runs/:id/verified-excel), replacing the
// old manual Generate Report -> Build Report wizard.

interface RowSpec {
  keyword: string;
  targetUrl: string;
  locationName?: string;
  seDomain?: string;
  languageName?: string;
  status?: string;
  rank?: string;
}

async function buildWorkbookBuffer(rows: RowSpec[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(Object.values(COLUMN_HEADERS));
  for (const row of rows) {
    sheet.addRow([
      row.keyword,
      `https://example.com${row.targetUrl}`,
      row.targetUrl,
      `${row.keyword} example.com`,
      row.locationName ?? "Australia",
      row.seDomain ?? "google.com.au",
      row.languageName ?? "English",
      row.status ?? "Completed",
      row.rank ?? "",
      row.rank ? `https://example.com${row.targetUrl}` : "",
    ]);
  }
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

async function makeClient() {
  return prisma.client.create({ data: { name: `Verified Excel Upload Test - ${randomUUID()}` } });
}

async function makeCompletedRun(clientId: string, rows: RowSpec[]) {
  const buffer = await buildWorkbookBuffer(rows);
  const { run } = await ingestExcelRun({
    clientId,
    sourceFilename: "run.xlsx",
    sourceFilePath: "local-test/run.xlsx",
    fileBuffer: buffer,
  });
  return prisma.rankingRun.update({ where: { id: run.id }, data: { status: "COMPLETED", completedAt: new Date() } });
}

async function cleanup(clientId: string) {
  const reports = await prisma.rankingReport.findMany({ where: { clientId } });
  await prisma.rankingReport.deleteMany({ where: { clientId } });
  const runs = await prisma.rankingRun.findMany({ where: { clientId } });
  for (const run of runs) await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.deleteMany({ where: { clientId } });
  const baselines = await prisma.rankingBaseline.findMany({ where: { clientId } });
  for (const b of baselines) await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: b.id } });
  await prisma.rankingBaseline.deleteMany({ where: { clientId } });
  await prisma.client.delete({ where: { id: clientId } });
  return reports;
}

test("processVerifiedExcelUpload: first verified upload for a client has no comparison, and becomes the baseline", async () => {
  const client = await makeClient();
  try {
    const run = await makeCompletedRun(client.id, [
      { keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" },
      { keyword: "car wreckers perth", targetUrl: "/perth", rank: "" },
    ]);

    const verifiedBuffer = await buildWorkbookBuffer([
      { keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" },
      { keyword: "car wreckers perth", targetUrl: "/perth", rank: "" },
    ]);

    const result = await processVerifiedExcelUpload(run.id, verifiedBuffer, "verified-a.xlsx", "qa@example.com");
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;

    const analytics = result.report.analyticsJson as any;
    assert.equal(analytics.hasComparison, false, "a client's first verified upload has nothing to compare against");
    assert.equal(result.report.previousBaselineId, null);
    assert.equal(result.report.status, "PENDING_APPROVAL", "build + email draft run automatically");

    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id } });
    assert.equal(baselines.length, 1, "the first verified upload becomes the client's baseline");
    assert.equal(baselines[0].sourceFilename, "verified-a.xlsx");
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: a second verified upload compares against the first (Improved/Dropped/No Change), and becomes the new baseline without deleting the old one", async () => {
  const client = await makeClient();
  try {
    const runA = await makeCompletedRun(client.id, [
      { keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "20" }, // will improve
      { keyword: "car wreckers perth", targetUrl: "/perth", rank: "5" }, // will drop
      { keyword: "car wreckers joondalup", targetUrl: "/joondalup", rank: "8" }, // unchanged
    ]);
    const verifiedA = await buildWorkbookBuffer([
      { keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "20" },
      { keyword: "car wreckers perth", targetUrl: "/perth", rank: "5" },
      { keyword: "car wreckers joondalup", targetUrl: "/joondalup", rank: "8" },
    ]);
    const first = await processVerifiedExcelUpload(runA.id, verifiedA, "verified-a.xlsx", "qa@example.com");
    assert.equal(first.outcome, "SUCCESS");

    const runB = await makeCompletedRun(client.id, [
      { keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" },
      { keyword: "car wreckers perth", targetUrl: "/perth", rank: "9" },
      { keyword: "car wreckers joondalup", targetUrl: "/joondalup", rank: "8" },
    ]);
    const verifiedB = await buildWorkbookBuffer([
      { keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }, // 20 -> 12: improved
      { keyword: "car wreckers perth", targetUrl: "/perth", rank: "9" }, // 5 -> 9: declined
      { keyword: "car wreckers joondalup", targetUrl: "/joondalup", rank: "8" }, // unchanged
    ]);

    const second = await processVerifiedExcelUpload(runB.id, verifiedB, "verified-b.xlsx", "qa@example.com");
    assert.equal(second.outcome, "SUCCESS");
    if (second.outcome !== "SUCCESS") return;

    const analytics = second.report.analyticsJson as any;
    assert.equal(analytics.hasComparison, true);
    assert.equal(analytics.movements.improved.length, 1);
    assert.equal(analytics.movements.improved[0].keyword, "car wreckers mandurah");
    assert.equal(analytics.movements.declined.length, 1);
    assert.equal(analytics.movements.declined[0].keyword, "car wreckers perth");
    assert.equal(analytics.movements.unchanged.length, 1);
    assert.equal(second.report.status, "PENDING_APPROVAL");

    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "asc" } });
    assert.equal(baselines.length, 2, "the previous baseline is never overwritten -- a new one is added alongside it");
    assert.equal(baselines[0].sourceFilename, "verified-a.xlsx");
    assert.equal(baselines[1].sourceFilename, "verified-b.xlsx");
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: rejects a run that hasn't completed yet", async () => {
  const client = await makeClient();
  try {
    const run = await prisma.rankingRun.create({
      data: { clientId: client.id, sourceFilename: "run.xlsx", sourceFilePath: "local-test/run.xlsx", totalRows: 0, status: "UPLOADED" },
    });
    const buffer = await buildWorkbookBuffer([{ keyword: "x", targetUrl: "/x", rank: "1" }]);
    const result = await processVerifiedExcelUpload(run.id, buffer, "verified.xlsx", null);
    assert.equal(result.outcome, "RUN_NOT_COMPLETED");
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: rejects a verified Excel that doesn't match this run's rows", async () => {
  const client = await makeClient();
  try {
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    // A completely different keyword/URL -- computes a different rowUid, so it can never match this run's row.
    const wrongBuffer = await buildWorkbookBuffer([{ keyword: "totally unrelated keyword", targetUrl: "/nope", rank: "3" }]);

    const result = await processVerifiedExcelUpload(run.id, wrongBuffer, "wrong.xlsx", null);
    assert.equal(result.outcome, "UNMATCHED_ROWS");
    if (result.outcome !== "UNMATCHED_ROWS") return;
    assert.deepEqual(result.unmatchedKeywords, ["totally unrelated keyword"]);

    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id } });
    assert.equal(baselines.length, 0, "a rejected upload must never become a baseline");
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: a second upload for the same run is rejected as a duplicate report, and never touches the run's stored rows", async () => {
  const client = await makeClient();
  try {
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const buffer = await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);

    const first = await processVerifiedExcelUpload(run.id, buffer, "verified.xlsx", null);
    assert.equal(first.outcome, "SUCCESS");

    // A different rank than what's already stored -- if the duplicate check
    // ran AFTER applying corrections (the bug this regression test guards
    // against), this would silently overwrite the run's row despite no new
    // report/baseline ever being produced from it.
    const conflictingBuffer = await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "99" }]);
    const second = await processVerifiedExcelUpload(run.id, conflictingBuffer, "verified.xlsx", null);
    assert.equal(second.outcome, "DUPLICATE_REPORT");

    const rows = await prisma.rankingRow.findMany({ where: { runId: run.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rankDisplay, "12", "the rejected duplicate upload must not have mutated the run's stored rank");
  } finally {
    await cleanup(client.id);
  }
});

test("POST /api/runs/:id/verified-excel: the actual HTTP route wires auth + multipart upload through to processVerifiedExcelUpload", async () => {
  const auth: AuthFixture = await createAuthenticatedSession();
  const app = createApp(unusedCallDataForSeo, "mock");
  const client = await prisma.client.create({ data: { name: `Verified Excel HTTP Test - ${randomUUID()}`, workspaceId: auth.workspace.id } });
  try {
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const buffer = await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "8" }]);

    const unauthed = await authedRequest(app, "").post(`/api/runs/${run.id}/verified-excel`).attach("file", buffer, "verified.xlsx");
    assert.equal(unauthed.status, 401);

    const res = await authedRequest(app, auth.cookieHeader).post(`/api/runs/${run.id}/verified-excel`).attach("file", buffer, "verified.xlsx");
    assert.equal(res.status, 201);
    assert.equal(res.body.report.status, "PENDING_APPROVAL");

    const noFile = await authedRequest(app, auth.cookieHeader).post(`/api/runs/${run.id}/verified-excel`);
    assert.equal(noFile.status, 400);
  } finally {
    await cleanup(client.id);
  }
});

test.after(async () => {
  await prisma.$disconnect();
});
