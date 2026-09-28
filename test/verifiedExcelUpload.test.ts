import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { ingestExcelRun } from "../backend/runs/ingestExcelRun.js";
import { processVerifiedExcelUpload, regenerateReport } from "../backend/reporting/processVerifiedExcelUpload.js";
import { formatOrdinalDate } from "../backend/reporting/formatOrdinalDate.js";
import { approveAndSendReport } from "../backend/reporting/approveAndSend.js";
import { createMockEmailSender, createFailingMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { createBaselineFromRows } from "../backend/baselines/createBaselineFromRows.js";
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

/** Approve & Send through the mock sender -- the only step that turns a verified run into a baseline. */
async function sendReport(reportId: string, sendEmail = createMockEmailSender()) {
  await prisma.rankingReport.update({ where: { id: reportId }, data: { resolvedRecipients: ["client@example.com"] } });
  return approveAndSendReport(reportId, { approvedBy: "qa@example.com", sendEmail });
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

    assert.equal(await prisma.rankingBaseline.count({ where: { clientId: client.id } }), 0, "nothing becomes a baseline before the report is sent");

    assert.equal((await sendReport(result.report.id)).outcome, "SENT");
    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id } });
    assert.equal(baselines.length, 1, "once sent, the first verified upload becomes the client's baseline");
    assert.equal(baselines[0].sourceFilename, "verified-a.xlsx");
    assert.equal(baselines[0].sourceRunId, run.id);
  } finally {
    await cleanup(client.id);
  }
});

// Answers a real question: a client onboarded via Client Management's
// "Upload Previous Ranking" (an agency's existing report, imported as a
// RankingBaseline -- see backend/api/routes/baselines.ts /
// createBaselineFromRows.ts) has NO prior verified-Excel upload yet, but
// DOES already have a baseline row. processVerifiedExcelUpload's baseline
// lookup is source-agnostic -- it just takes the client's most recently
// created RankingBaseline, whoever created it -- so their first-ever
// verified-Excel upload should compare against that imported baseline
// instead of showing "no comparison."
test("processVerifiedExcelUpload: a client's first verified upload compares against a baseline manually imported via Client Management", async () => {
  const client = await makeClient();
  try {
    const importedBaseline = await createBaselineFromRows(client.id, {
      sourceFilename: "agency-report.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date("2026-08-01"),
      createdBy: "qa@example.com",
      rows: [{ keyword: "car wreckers mandurah", rankValue: 20, rankDisplay: "20" }],
    });

    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const verifiedBuffer = await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);

    const result = await processVerifiedExcelUpload(run.id, verifiedBuffer, "verified-a.xlsx", "qa@example.com");
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;

    assert.equal(result.report.previousBaselineId, importedBaseline.id, "compares against the imported baseline, not 'no comparison'");
    const analytics = result.report.analyticsJson as any;
    assert.equal(analytics.hasComparison, true);
    assert.equal(analytics.movements.improved.length, 1, "20 -> 12 is an improvement");
    assert.equal(analytics.movements.improved[0].previousRank, 20);
    assert.equal(analytics.movements.improved[0].currentRank, 12);

    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "asc" } });
    assert.equal(baselines.length, 1, "the imported baseline is kept; the upload adds nothing until it's sent");
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
    if (first.outcome !== "SUCCESS") return;
    assert.equal((await sendReport(first.report.id)).outcome, "SENT");

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

    assert.equal((await sendReport(second.report.id)).outcome, "SENT");
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

// -- Repeatable report generation ------------------------------------------
// Upload -> review -> fix -> upload again (or Regenerate) -> ... until sent.

test("processVerifiedExcelUpload: uploading an UPDATED file for the same run rebuilds the same report in place, with one baseline for the run", async () => {
  const client = await makeClient();
  try {
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const first = await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]), "verified.xlsx", null);
    assert.equal(first.outcome, "SUCCESS");
    if (first.outcome !== "SUCCESS") return;
    assert.equal(first.regenerated, false);

    const second = await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "9" }]), "verified-v2.xlsx", null);
    assert.equal(second.outcome, "SUCCESS");
    if (second.outcome !== "SUCCESS") return;
    assert.equal(second.regenerated, true);
    assert.equal(second.rowsChanged, 1);
    assert.equal(second.report.id, first.report.id, "the same report is rebuilt, not a second one created");
    assert.equal(second.report.status, "PENDING_APPROVAL");
    assert.equal(await prisma.rankingReport.count({ where: { runId: run.id } }), 1);

    const rows = await prisma.rankingRow.findMany({ where: { runId: run.id } });
    assert.equal(rows[0].rankDisplay, "9", "the updated file's rank is applied");

    assert.equal(await prisma.rankingBaseline.count({ where: { clientId: client.id } }), 0, "re-uploading never creates a baseline");
    assert.equal((await sendReport(second.report.id)).outcome, "SENT");
    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id }, include: { rows: true } });
    assert.equal(baselines.length, 1, "sending creates exactly one baseline for the run, from the last upload");
    assert.equal(baselines[0].sourceRunId, run.id);
    assert.equal(baselines[0].sourceFilename, "verified-v2.xlsx");
    assert.equal(baselines[0].rows[0].rankDisplay, "9");
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: re-uploading the SAME file regenerates with identical numbers and reports zero changed rows", async () => {
  const client = await makeClient();
  try {
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const buffer = await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const first = await processVerifiedExcelUpload(run.id, buffer, "verified.xlsx", null);
    const again = await processVerifiedExcelUpload(run.id, buffer, "verified.xlsx", null);
    assert.equal(first.outcome, "SUCCESS");
    assert.equal(again.outcome, "SUCCESS");
    if (first.outcome !== "SUCCESS" || again.outcome !== "SUCCESS") return;
    assert.equal(again.rowsChanged, 0);
    assert.deepEqual((again.report.analyticsJson as any).totals, (first.report.analyticsJson as any).totals);
    assert.equal(await prisma.rankingBaseline.count({ where: { clientId: client.id } }), 0);
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: every regeneration keeps comparing against the SAME previous baseline, never the run's own", async () => {
  const client = await makeClient();
  try {
    const imported = await createBaselineFromRows(client.id, {
      sourceFilename: "agency-15-sep.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date("2026-09-15"),
      rows: [{ keyword: "car wreckers mandurah", rankValue: 20, rankDisplay: "20" }],
    });
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    for (const rank of ["12", "15", "15"]) {
      const result = await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank }]), "verified.xlsx", null);
      assert.equal(result.outcome, "SUCCESS");
      if (result.outcome !== "SUCCESS") return;
      assert.equal(result.report.previousBaselineId, imported.id, `upload with rank ${rank} still compares against the imported 15 Sep baseline`);
      assert.equal(result.previousBaseline?.sourceFilename, "agency-15-sep.xlsx");
      assert.equal((result.report.analyticsJson as any).movements.improved[0].previousRank, 20);
    }
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: 'previous' is the latest RANKING date, not the latest upload", async () => {
  const client = await makeClient();
  try {
    const sep15 = await createBaselineFromRows(client.id, {
      sourceFilename: "15-sep.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date("2026-09-15"),
      rows: [{ keyword: "car wreckers mandurah", rankValue: 20, rankDisplay: "20" }],
    });
    // Uploaded AFTER the 15 Sep one, but holds older (31 Aug) ranks.
    await createBaselineFromRows(client.id, {
      sourceFilename: "31-aug.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date("2026-08-31"),
      rows: [{ keyword: "car wreckers mandurah", rankValue: 40, rankDisplay: "40" }],
    });
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const result = await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]), "verified.xlsx", null);
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    assert.equal(result.report.previousBaselineId, sep15.id);
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: a report already SENT (or being sent) is locked -- the upload changes nothing", async () => {
  const client = await makeClient();
  try {
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const first = await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]), "verified.xlsx", null);
    assert.equal(first.outcome, "SUCCESS");
    if (first.outcome !== "SUCCESS") return;

    for (const status of ["SENT", "SENDING"] as const) {
      await prisma.rankingReport.update({ where: { id: first.report.id }, data: { status } });
      const blocked = await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "99" }]), "verified.xlsx", null);
      assert.equal(blocked.outcome, "REPORT_LOCKED");
      if (blocked.outcome !== "REPORT_LOCKED") return;
      assert.equal(blocked.reason, status);
      const rows = await prisma.rankingRow.findMany({ where: { runId: run.id } });
      assert.equal(rows[0].rankDisplay, "12", `a ${status} report's run rows must not be touched`);
    }
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: an older run can't be regenerated once a newer report compared against it", async () => {
  const client = await makeClient();
  try {
    const runA = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "20" }]);
    const bufferA = await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "20" }]);
    assert.equal((await processVerifiedExcelUpload(runA.id, bufferA, "a.xlsx", null)).outcome, "SUCCESS");
    // A baseline made from run A while its report is still unsent -- only
    // possible under the old generate-time rule (e.g. existing production
    // reports), which is exactly what this guard protects.
    await createBaselineFromRows(client.id, {
      sourceFilename: "a.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date(),
      sourceRunId: runA.id,
      rows: [{ keyword: "car wreckers mandurah", rankValue: 20, rankDisplay: "20" }],
    });

    const runB = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const b = await processVerifiedExcelUpload(runB.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]), "b.xlsx", null);
    assert.equal(b.outcome, "SUCCESS");

    const again = await processVerifiedExcelUpload(runA.id, bufferA, "a.xlsx", null);
    assert.equal(again.outcome, "BASELINE_IN_USE");
  } finally {
    await cleanup(client.id);
  }
});

test("regenerateReport: rebuilds from the run's current rows with no file, keeps edited recipients, and dates PDF/email/baseline the same day", async () => {
  const client = await makeClient();
  try {
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const first = await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]), "verified.xlsx", null);
    assert.equal(first.outcome, "SUCCESS");
    if (first.outcome !== "SUCCESS") return;
    await prisma.rankingReport.update({ where: { id: first.report.id }, data: { resolvedRecipients: ["client@example.com"], resolvedCc: ["boss@example.com"] } });

    const regenerated = await regenerateReport(first.report.id, null);
    assert.equal(regenerated.outcome, "SUCCESS");
    if (regenerated.outcome !== "SUCCESS") return;
    assert.equal(regenerated.report.id, first.report.id);
    assert.equal(regenerated.rowsChanged, null);
    assert.equal(regenerated.report.status, "PENDING_APPROVAL");
    assert.deepEqual(regenerated.report.resolvedRecipients, ["client@example.com"], "hand-edited recipients survive a regenerate");
    assert.deepEqual(regenerated.report.resolvedCc, ["boss@example.com"]);

    const reportDate = regenerated.report.reportDate!;
    assert.ok(reportDate, "reportDate is recorded when the PDF is built");
    assert.equal((await sendReport(regenerated.report.id)).outcome, "SENT");
    const own = await prisma.rankingBaseline.findFirstOrThrow({ where: { sourceRunId: run.id } });
    assert.equal(own.baselineDate.getTime(), reportDate.getTime(), "the baseline created at send is dated the same day as the PDF");
    assert.ok(regenerated.report.emailSubject?.includes(formatOrdinalDate(reportDate)), "the email's end date is the PDF's date");
  } finally {
    await cleanup(client.id);
  }
});

test("processVerifiedExcelUpload: the comparison is pinned -- a baseline uploaded between regenerates does NOT change it", async () => {
  const client = await makeClient();
  try {
    const sep15 = await createBaselineFromRows(client.id, {
      sourceFilename: "15-sep.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date("2026-09-15"),
      rows: [{ keyword: "car wreckers mandurah", rankValue: 20, rankDisplay: "20" }],
    });
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const buffer = await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const first = await processVerifiedExcelUpload(run.id, buffer, "verified.xlsx", null);
    assert.equal(first.outcome, "SUCCESS");
    if (first.outcome !== "SUCCESS") return;
    assert.equal(first.report.previousBaselineId, sep15.id);

    // Someone imports a NEWER-dated baseline while the report is under review.
    await createBaselineFromRows(client.id, {
      sourceFilename: "20-sep.xlsx",
      sourceType: "EXCEL",
      baselineDate: new Date("2026-09-20"),
      rows: [{ keyword: "car wreckers mandurah", rankValue: 3, rankDisplay: "3" }],
    });

    const reuploaded = await processVerifiedExcelUpload(run.id, buffer, "verified.xlsx", null);
    const regenerated = await regenerateReport(first.report.id, null);
    for (const result of [reuploaded, regenerated]) {
      assert.equal(result.outcome, "SUCCESS");
      if (result.outcome !== "SUCCESS") return;
      assert.equal(result.report.previousBaselineId, sep15.id, "still compares against the baseline chosen on the first upload");
      assert.equal((result.report.analyticsJson as any).movements.improved[0].previousRank, 20);
    }
  } finally {
    await cleanup(client.id);
  }
});

test("approveAndSend: a verified report becomes the client's baseline only after a SUCCESSFUL send", async () => {
  const client = await makeClient();
  try {
    const run = await makeCompletedRun(client.id, [{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]);
    const result = await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "12" }]), "verified.xlsx", null);
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;

    const failed = await sendReport(result.report.id, createFailingMockEmailSender());
    assert.equal(failed.outcome, "SEND_FAILED");
    assert.equal(await prisma.rankingBaseline.count({ where: { clientId: client.id } }), 0, "a failed send creates no baseline");

    // Still editable after a failed send, then sent for real.
    assert.equal((await processVerifiedExcelUpload(run.id, await buildWorkbookBuffer([{ keyword: "car wreckers mandurah", targetUrl: "/mandurah", rank: "10" }]), "verified-v2.xlsx", null)).outcome, "SUCCESS");
    assert.equal((await sendReport(result.report.id)).outcome, "SENT");
    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id }, include: { rows: true } });
    assert.equal(baselines.length, 1);
    assert.equal(baselines[0].sourceFilename, "verified-v2.xlsx");
    assert.equal(baselines[0].rows[0].rankDisplay, "10", "the baseline holds exactly the ranks that were sent");
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
