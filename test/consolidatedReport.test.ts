import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import { buildConsolidatedReport, columnLabel, describeConsolidatedFile, shiftFormula } from "../backend/reporting/consolidatedReport.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";
import { notifyRunCompletion } from "../backend/notifications/createNotification.js";

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

test("shiftFormula moves row refs like a copy-paste and shifts columns for the inserted date column", () => {
  assert.equal(shiftFormula('IF(AND(ISNUMBER(V4),ISNUMBER(W4)),V4-W4,"")', 6, 3), 'IF(AND(ISNUMBER(W10),ISNUMBER(X10)),W10-X10,"")');
  assert.equal(shiftFormula("SUM($B$4:B4)+LOG10(C2)", 1, null), "SUM($B$4:B5)+LOG10(C3)");
  assert.equal(shiftFormula('"V4"&Sheet2!V4&B4', 1, 2), '"V4"&Sheet2!V4&C5');
});

test("buildConsolidatedReport: a file with shared formulas (Vastrado's GSC 'Click Change') builds, each formula follows its row", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ranking Report + GSC");
  ws.getRow(1).values = ["Keyword", "03rd Nov 26", "26th Oct 26", "GSC Clicks Oct 26", "GSC Clicks Sep 26", "Click Change"];
  ws.getRow(2).values = ["boxy shirts", 1, 1, 202, 176];
  ws.getRow(3).values = ["plain shirt", 9, 9, 10, 4];
  ws.getRow(4).values = ["linen shirt", 30, 31, 7, 9];
  ws.getCell("F2").value = { formula: "D2-E2", result: 26, ref: "F2:F4", shareType: "shared" } as ExcelJS.CellValue;
  ws.getCell("F3").value = { sharedFormula: "F2", result: 6 } as ExcelJS.CellValue;
  ws.getCell("F4").value = { sharedFormula: "F2", result: -2 } as ExcelJS.CellValue;
  const history = Buffer.from(await wb.xlsx.writeBuffer());
  const built = await buildConsolidatedReport(history, {
    reportDate: new Date("2026-11-17T00:00:00Z"),
    rows: [
      { keyword: "boxy shirts", rankValue: 4, rankDisplay: "4" },
      { keyword: "plain shirt", rankValue: 2, rankDisplay: "2" },
      { keyword: "linen shirt", rankValue: 1, rankDisplay: "1" },
    ],
  });
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(built.buffer as unknown as ArrayBuffer);
  const s = out.worksheets[0];
  const at = (r: number) => [s.getCell(r, 1).value, s.getCell(r, 2).value, (s.getCell(r, 7).value as { formula: string }).formula];
  assert.deepEqual(at(2), ["linen shirt", 1, "E2-F2"]);
  assert.deepEqual(at(3), ["plain shirt", 2, "E3-F3"]);
  assert.deepEqual(at(4), ["boxy shirts", 4, "E4-F4"]);
  assert.equal(s.getCell(4, 5).value, 202);
});

test("buildConsolidatedReport: a 'highlight duplicates' rule ExcelJS can't write is left out (no empty <conditionalFormatting> for Excel to call corrupt)", async () => {
  const history = await historyFile([["divorce lawyer", [1, 2, 3]]]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(history as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  ws.addConditionalFormatting({ ref: "A4", rules: [{ type: "expression", priority: 2, formulae: ["A4=\"x\""], style: {} }] });
  (ws as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings.push({ ref: "A5", rules: [{ type: "duplicateValues", priority: 1, style: {} }] });
  const withRules = Buffer.from(await wb.xlsx.writeBuffer());
  const built = await buildConsolidatedReport(withRules, { reportDate: new Date("2026-11-23T00:00:00Z"), rows: [{ keyword: "divorce lawyer", rankValue: 1, rankDisplay: "1" }] });
  const JSZip = (await import("jszip")).default;
  const xml = await (await JSZip.loadAsync(built.buffer)).file("xl/worksheets/sheet1.xml")!.async("string");
  assert.doesNotMatch(xml, /<conditionalFormatting[^>]*\/>/);
  assert.match(xml, /<cfRule type="expression"/);
});

test("columnLabel follows the file's own date style", () => {
  assert.equal(columnLabel(new Date("2026-11-03T10:00:00Z"), "30th Oct 26"), "03rd Nov 26");
  assert.equal(columnLabel(new Date("2026-09-15T10:00:00Z"), "30th Oct 26"), "15th Sept 26");
  assert.equal(columnLabel(new Date("2026-11-03T10:00:00Z"), "15th October 2026"), "3rd November 2026");
});

test("buildConsolidatedReport: the date under the title moves to the report date and the new column gets its 'Google.ae' (Maiz-style file, 2026-11-27)", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ranking");
  ws.getCell(1, 1).value = "Client Keyword Ranking Report";
  ws.getCell(2, 1).value = "edumaiz.com";
  ws.getCell(3, 1).value = "3rd November 2026"; // stale in the uploaded file -- still becomes the report date
  ws.getRow(5).values = ["Current Ranking Status:", "Google.ae", "Google.ae", "Google.ae"];
  ws.getRow(6).values = ["Keyword", "17th November 2026", "3rd November 2026", "15th October 2026"];
  ws.getRow(7).values = ["germany education consultants in dubai", 5, 7, 9];
  ws.getRow(8).values = ["study in uk", "Not in 100", "Not in 100", 40];
  const history = Buffer.from(await wb.xlsx.writeBuffer());

  const built = await buildConsolidatedReport(history, {
    reportDate: new Date("2026-11-26T00:00:00Z"),
    rows: [
      { keyword: "germany education consultants in dubai", rankValue: 4, rankDisplay: "4" },
      { keyword: "study in uk", rankValue: null, rankDisplay: "Not in 100" },
    ],
  });
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(built.buffer as unknown as ArrayBuffer);
  const sheet = out.worksheets[0];
  assert.equal(sheet.getCell(3, 1).value, "26th November 2026", "date under the title is this report's date");
  assert.deepEqual((sheet.getRow(5).values as unknown[]).slice(1), ["Current Ranking Status:", "Google.ae", "Google.ae", "Google.ae", "Google.ae"]);
  assert.deepEqual((sheet.getRow(6).values as unknown[]).slice(1), ["Keyword", "26th November 2026", "17th November 2026", "3rd November 2026", "15th October 2026"]);
  assert.equal(sheet.getCell(2, 1).value, "edumaiz.com");
  assert.equal(sheet.getCell(1, 1).value, "Client Keyword Ranking Report");
  assert.equal(sheet.getCell(7, 2).value, 4);
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

test("report type (2026-11-23): normal / consolidated / not confirmed; the report page's switch also confirms", async () => {
  const t = await setup({ consolidated: false });
  try {
    const url = `/api/clients/${t.client.id}/consolidated`;
    assert.equal((await t.api.get(url)).body.reportType, "unconfirmed");
    assert.equal((await t.api.patch(url).send({ reportType: "normal" })).body.reportType, "normal");
    const consolidated = (await t.api.patch(url).send({ reportType: "consolidated" })).body;
    assert.deepEqual([consolidated.reportType, consolidated.enabled], ["consolidated", true]);
    assert.equal((await t.api.patch(url).send({ reportType: "unconfirmed" })).body.reportType, "unconfirmed");
    assert.equal((await t.api.patch(url).send({ reportType: "pdf" })).status, 400);
    assert.equal((await t.api.patch(url).send({})).status, 400);
    assert.equal((await t.api.patch(url).send({ enabled: false })).body.reportType, "normal");
    const row = await prisma.client.findUniqueOrThrow({ where: { id: t.client.id } });
    assert.deepEqual([row.consolidatedReport, row.reportTypeConfirmed], [false, true]);
  } finally {
    await t.cleanup();
  }
});

test("a finished run asks to confirm the report type until it's set", async () => {
  const t = await setup({ consolidated: false });
  try {
    const run = await prisma.rankingRun.findFirstOrThrow({ where: { clientId: t.client.id } });
    const asks = () => prisma.notification.count({ where: { clientId: t.client.id, type: "REPORT_TYPE_UNCONFIRMED" } });
    await notifyRunCompletion(run);
    assert.equal(await asks(), 1);
    const ask = await prisma.notification.findFirstOrThrow({ where: { clientId: t.client.id, type: "REPORT_TYPE_UNCONFIRMED" } });
    assert.match(ask.message, /Confirm the report type for Consolidated/);
    await t.api.patch(`/api/clients/${t.client.id}/consolidated`).send({ reportType: "normal" });
    await notifyRunCompletion(run);
    assert.equal(await asks(), 1);
    assert.equal(await prisma.notification.count({ where: { clientId: t.client.id, type: "RUN_COMPLETED" } }), 2);
  } finally {
    await t.cleanup();
  }
});
