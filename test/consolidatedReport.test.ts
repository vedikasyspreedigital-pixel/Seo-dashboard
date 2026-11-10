import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { buildConsolidatedReport, columnLabel, describeConsolidatedFile } from "../backend/reporting/consolidatedReport.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// "Consolidated report" (2026-11-10): AKT/Vastrado get ONE Excel with every past date as a column instead of
// the 2-date PDF. The dashboard keeps the client's last consolidated file and adds the new column in front.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("no DataForSEO here");
};

let auth: AuthFixture;
test.before(async () => {
  auth = await createAuthenticatedSession();
});
test.after(async () => {
  await auth.cleanup();
  await prisma.$disconnect();
});

/** A consolidated file like AKT's: title rows, "Keywords" header, newest date first. */
async function historyFile(keywords: [string, (string | number)[]][], dates = ["30th Oct 26", "14th Oct 26", "05th Oct 26"], extra?: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Table 1");
  const width = 1 + (extra ? 1 : 0) + dates.length;
  ws.getCell(1, 1).value = "Client Keyword Ranking Report \nexample.com";
  ws.mergeCells(1, 1, 1, width);
  ws.getCell(2, 1).value = "Current Ranking Status:";
  ws.mergeCells(2, 1, 2, width);
  ws.getRow(3).values = ["Keywords", ...(extra ? [extra] : []), ...dates];
  for (let c = 1; c <= width; c++) ws.getCell(3, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC65911" } };
  keywords.forEach(([k, ranks], i) => (ws.getRow(4 + i).values = [k, ...(extra ? [1000 + i] : []), ...ranks]));
  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 18;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function readBack(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const rows: unknown[][] = [];
  for (let r = 3; r <= ws.rowCount; r++) rows.push((ws.getRow(r).values as unknown[]).slice(1));
  return { ws, rows, merges: (ws.model as unknown as { merges: string[] }).merges };
}

test("buildConsolidatedReport: new column in front, rows sorted by the new rank, extras kept, new/removed keywords handled", async () => {
  const history = await historyFile(
    [
      ["divorce lawyer", [1, 3, "Not in 100"]],
      ["custody lawyer", [5, 6, 9]],
      ["old keyword", [2, 2, 2]],
      ["alimony lawyer", ["Not in 100", "Not in 100", "Not in 100"]],
    ],
    undefined,
    "Avg Monthly Searches",
  );
  const out = await buildConsolidatedReport(history, {
    reportDate: new Date("2026-11-14T09:00:00Z"),
    rows: [
      { keyword: "Divorce Lawyer", rankValue: 4, rankDisplay: "4" },
      { keyword: "custody lawyer", rankValue: 2, rankDisplay: "2" },
      { keyword: "alimony lawyer", rankValue: null, rankDisplay: "Not in 100" },
      { keyword: "new keyword", rankValue: 7, rankDisplay: "7" },
    ],
  });
  assert.equal(out.newColumnLabel, "14th Nov 26");
  assert.deepEqual(out.dropped, ["old keyword"]);
  assert.deepEqual(out.added, ["new keyword"]);
  assert.equal(out.dateColumns, 4);
  assert.equal(out.keywordCount, 4);

  const { rows, merges } = await readBack(out.buffer);
  assert.deepEqual(rows[0], ["Keywords", "Avg Monthly Searches", "14th Nov 26", "30th Oct 26", "14th Oct 26", "05th Oct 26"]);
  assert.deepEqual(rows[1], ["custody lawyer", 1001, 2, 5, 6, 9], "best new rank first, its history and extra column kept");
  assert.deepEqual(rows[2], ["divorce lawyer", 1000, 4, 1, 3, "Not in 100"]);
  assert.equal(rows[3][0], "new keyword");
  assert.equal(rows[3][1] ?? null, null, "a new keyword has no extra value");
  assert.equal(rows[3][2], 7);
  assert.equal(rows[3].slice(3).filter((v) => v !== null && v !== undefined).length, 0, "and no history");
  assert.deepEqual(rows[4], ["alimony lawyer", 1003, "Not in 100", "Not in 100", "Not in 100", "Not in 100"]);
  assert.equal(rows.length, 5, "the dropped keyword's row is gone");
  assert.deepEqual([...merges].sort(), ["A1:F1", "A2:F2"], "title rows stretch over the new column");

  // The result is itself a valid history for the next report.
  const info = await describeConsolidatedFile(out.buffer);
  assert.equal(info.newestDate.toISOString().slice(0, 10), "2026-11-14");
  assert.equal(info.dateColumns, 4);
});

test("columnLabel follows the file's own date style", () => {
  assert.equal(columnLabel(new Date("2026-11-03T10:00:00Z"), "30th Oct 26"), "03rd Nov 26");
  assert.equal(columnLabel(new Date("2026-09-15T10:00:00Z"), "30th Oct 26"), "15th Sept 26");
  assert.equal(columnLabel(new Date("2026-11-03T10:00:00Z"), "15th October 2026"), "3rd November 2026");
});

async function setup(opts: { consolidated: boolean }) {
  const sentCalls: { excelPdfFilename?: string; excelPdfBuffer?: Buffer }[] = [];
  const app = createApp(neverCalled, "mock", undefined, { sendEmail: createMockEmailSender((p) => sentCalls.push(p)) });
  const api = authedRequest(app, auth.cookieHeader);
  const client = await prisma.client.create({ data: { name: `Consolidated ${randomUUID().slice(0, 8)}`, workspaceId: auth.workspace.id, consolidatedReport: opts.consolidated } });
  const run = await prisma.rankingRun.create({
    data: { clientId: client.id, sourceFilename: "akt.xlsx", sourceFilePath: "x", totalRows: 2, status: "COMPLETED", completedAt: new Date("2026-11-14T08:00:00Z") },
  });
  for (const [i, [keyword, rank]] of ([["divorce lawyer", 3], ["custody lawyer", null]] as const).entries()) {
    await prisma.rankingRow.create({
      data: {
        runId: run.id, rowUid: randomUUID(), sourceRowNumber: i + 2, keyword, targetUrl: "*example.*", locationName: "India", seDomain: "google.co.in", languageName: "English",
        status: "COMPLETED", rankValue: rank, rankDisplay: rank === null ? "Not in 100" : String(rank),
      },
    });
  }
  const report = await prisma.rankingReport.create({
    data: {
      clientId: client.id, runId: run.id, status: ReportStatus.PENDING_APPROVAL, reportDate: new Date("2026-11-14T09:00:00Z"), analyticsJson: {},
      emailSubject: "AKT Keyword Ranking Report", emailBody: "Hi", resolvedRecipients: ["client@example.com"],
    },
  });
  const cleanup = async () => {
    await prisma.consolidatedHistory.deleteMany({ where: { clientId: client.id } });
    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id } });
    await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: { in: baselines.map((b) => b.id) } } });
    await prisma.rankingBaseline.deleteMany({ where: { clientId: client.id } });
    await prisma.notification.deleteMany({ where: { clientId: client.id } }).catch(() => {});
    await prisma.reportSend.deleteMany({ where: { reportId: report.id } });
    await prisma.rankingReport.deleteMany({ where: { clientId: client.id } });
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  };
  return { api, client, report, sentCalls, cleanup };
}

test("consolidated client: history upload, report preview, and the send attaches the consolidated Excel and saves it as the new history", async () => {
  const t = await setup({ consolidated: true });
  try {
    // No history yet: the report says so, and a send fails without emailing anyone.
    const info0 = await t.api.get(`/api/reports/${t.report.id}/consolidated/info`);
    assert.equal(info0.body.ready, false);
    assert.match(info0.body.error, /isn't uploaded yet/);
    const failed = await t.api.post(`/api/reports/${t.report.id}/approve-and-send`).send({});
    assert.equal(failed.body.outcome, "SEND_FAILED");
    assert.equal(t.sentCalls.length, 0);

    // A file that isn't a consolidated report is refused.
    const bad = await t.api.post(`/api/clients/${t.client.id}/consolidated/history`).attach("file", Buffer.from("not excel"), "x.xlsx");
    assert.equal(bad.status, 422);

    const up = await t.api
      .post(`/api/clients/${t.client.id}/consolidated/history`)
      .attach("file", await historyFile([["divorce lawyer", [1, 3, 4]], ["custody lawyer", [8, 9, 10]]]), "AKT - Consolidated Keyword Ranking Report.xlsx");
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.history.dateColumns, 3);
    assert.equal(up.body.newestLabel, "30th Oct 26");

    const info = await t.api.get(`/api/reports/${t.report.id}/consolidated/info`);
    assert.equal(info.body.ready, true, JSON.stringify(info.body));
    assert.equal(info.body.newColumnLabel, "14th Nov 26");
    const dl = await t.api.get(`/api/reports/${t.report.id}/consolidated`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(dl.status, 200);
    assert.equal((await describeConsolidatedFile(dl.body as Buffer)).dateColumns, 4);

    const sent = await t.api.post(`/api/reports/${t.report.id}/approve-and-send`).send({});
    assert.equal(sent.body.outcome, "SENT", JSON.stringify(sent.body));
    assert.equal(t.sentCalls.length, 1);
    assert.equal(t.sentCalls[0].excelPdfFilename, `${t.client.name} - Consolidated Keyword Ranking Report.xlsx`, "the Excel goes out instead of the PDF");
    const { rows } = await readBack(t.sentCalls[0].excelPdfBuffer!);
    assert.deepEqual(rows[1], ["divorce lawyer", 3, 1, 3, 4]);
    assert.deepEqual(rows[2], ["custody lawyer", "Not in 100", 8, 9, 10]);

    const history = await prisma.consolidatedHistory.findUniqueOrThrow({ where: { clientId: t.client.id } });
    assert.equal(history.source, "sent");
    assert.equal(history.reportId, t.report.id);
    assert.equal(history.newestDate.toISOString().slice(0, 10), "2026-11-14", "the next report builds on the one just sent");
    assert.equal(history.dateColumns, 4);
  } finally {
    await t.cleanup();
  }
});

test("a report older than the saved history is refused (it would add an older column in front)", async () => {
  const t = await setup({ consolidated: true });
  try {
    await t.api.post(`/api/clients/${t.client.id}/consolidated/history`).attach("file", await historyFile([["divorce lawyer", [1]]], ["20th Nov 26"]), "later.xlsx");
    const info = await t.api.get(`/api/reports/${t.report.id}/consolidated/info`);
    assert.equal(info.body.ready, false);
    assert.match(info.body.error, /already goes up to 2026-11-20/);
  } finally {
    await t.cleanup();
  }
});

test("switching the consolidated report on/off; a normal client's report isn't affected", async () => {
  const t = await setup({ consolidated: false });
  try {
    assert.deepEqual((await t.api.get(`/api/reports/${t.report.id}/consolidated/info`)).body, { enabled: false });
    const on = await t.api.patch(`/api/clients/${t.client.id}/consolidated`).send({ enabled: true });
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.history, null);
    assert.equal((await t.api.patch(`/api/clients/${t.client.id}/consolidated`).send({ enabled: "yes" })).status, 400);
    assert.equal((await t.api.patch(`/api/clients/${t.client.id}/consolidated`).send({ enabled: false })).body.enabled, false);
  } finally {
    await t.cleanup();
  }
});
