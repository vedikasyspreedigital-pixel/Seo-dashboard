import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import {
  CompareReportsError,
  clientNameFromFileName,
  compareReportFiles,
  locationsFromRows,
  sanitizeComparedRows,
} from "../backend/reporting/compareReportFiles.js";
import { buildClientReportHtml } from "../backend/reporting/generateClientReportPdf.js";
import { analyticsFromRows } from "../backend/reporting/compareReportFiles.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// "Compare Reports" tab: two finished report files in, one comparison PDF out.
// Stateless -- these tests also assert nothing is written to the database.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Compare Reports must never call DataForSEO");
};

/** A finished agency report as Excel: title block, header, optional location sections. */
async function reportWorkbook(opts: {
  newerLabel: string;
  olderLabel: string;
  rows: (string | number)[][];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ranking");
  sheet.addRow(["Client Keyword Ranking Report"]);
  sheet.addRow([{ text: "twincrown.com", hyperlink: "http://twincrown.com/" }]); // a real auto-linked cell
  sheet.addRow([opts.newerLabel]);
  sheet.mergeCells("A1:C1");
  sheet.mergeCells("A2:C2");
  sheet.mergeCells("A3:C3");
  sheet.addRow([]);
  sheet.addRow(["Current Ranking Status:", "Google.ae", "Google.ae"]);
  sheet.addRow(["Keyword", opts.newerLabel, opts.olderLabel]);
  for (const r of opts.rows) sheet.addRow(r);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// 31 Aug -> 15 Sep report (the OLDER one: its newest column is 15 Sep)
const OLDER = () =>
  reportWorkbook({
    newerLabel: "15th September 2026",
    olderLabel: "31st August 2026",
    rows: [
      ["tcs meters uae", 1, 1],
      ["oilfield equipment suppliers in dubai", 3, "Not in 100"],
      ["Saudi Arabia", "google.com.sa", "google.com.sa"],
      ["flow meter suppliers in saudi arabia", 19, 14],
      ["pump suppliers in saudi arabia", "Not in 100", 31],
      ["Qatar", "google.com.qa", "google.com.qa"],
      ["flow meter supplier in qatar", 12, 8],
      ["dropped keyword", 40, 40],
    ],
  });

// 15 Sep -> 1 Oct report (the NEWER one: its newest column is 1 Oct)
const NEWER = () =>
  reportWorkbook({
    newerLabel: "1st October 2026",
    olderLabel: "15th September 2026",
    rows: [
      ["tcs meters uae", 1, 1],
      ["oilfield equipment suppliers in dubai", 1, 3],
      ["Saudi Arabia", "google.com.sa", "google.com.sa"],
      ["flow meter suppliers in saudi arabia", 17, 19],
      ["pump suppliers in saudi arabia", 37, "Not in 100"],
      ["Qatar", "google.com.qa", "google.com.qa"],
      ["flow meter supplier in qatar", 15, 12],
      ["brand new keyword", 5, "Not in 100"],
    ],
  });

test("clientNameFromFileName: reads the client from a standard report file name", () => {
  assert.equal(clientNameFromFileName("Twin Crown - Keyword Ranking Report - 31st August 2026 - 15th September 2026.pdf"), "Twin Crown");
  assert.equal(clientNameFromFileName("Arnold's Fibreglass Repairs – Keyword Ranking Report – 15th September 2026 - 1st October 2026.xlsx"), "Arnold's Fibreglass Repairs");
  assert.equal(clientNameFromFileName("some other file.xlsx"), "some other file");
});

test("compareReportFiles: older/newer come from the dates (either upload order), newest column of each file is compared", async () => {
  const older = { buffer: await OLDER(), name: "Twin Crown - Keyword Ranking Report - 31st August 2026 - 15th September 2026.xlsx" };
  const newer = { buffer: await NEWER(), name: "Twin Crown - Keyword Ranking Report - 15th September 2026 - 1st October 2026.xlsx" };
  for (const [a, b] of [[older, newer], [newer, older]]) {
    const c = await compareReportFiles(a, b);
    assert.equal(c.older.dateLabel, "15th September 2026");
    assert.equal(c.newer.dateLabel, "1st October 2026");
    assert.equal(c.clientName, "Twin Crown");
    assert.equal(c.clientDomain, "twincrown.com", "website read from the (hyperlinked) title cell");
    assert.equal(c.primarySearchDomain, "google.ae");
    assert.deepEqual(c.sections, [{ name: "Saudi Arabia", domain: "google.com.sa" }, { name: "Qatar", domain: "google.com.qa" }]);
    assert.deepEqual(c.summary, { matched: 5, onlyInNewer: 1, onlyInOlder: 1, improved: 3, declined: 1, unchanged: 1 });
    // 15 Sep -> 1 Oct: dubai 3->1 improved, saudi 19->17 improved, saudi pump NotIn100->37 improved,
    // brand new keyword is newly tracked ("New" in the PDF), qatar 12->15 declined, tcs 1->1 unchanged.
    assert.equal(c.currentRows.find((r) => r.keyword === "flow meter supplier in qatar")!.section, "Qatar");
    assert.equal(c.currentRows.find((r) => r.keyword === "tcs meters uae")!.section, null);
  }
});

test("compareReportFiles: two reports with the same date are refused with a plain message", async () => {
  const buffer = await NEWER();
  await assert.rejects(
    () => compareReportFiles({ buffer, name: "a.xlsx" }, { buffer, name: "b.xlsx" }),
    (err: unknown) => err instanceof CompareReportsError && /Both reports are dated 1st October 2026/.test((err as Error).message),
  );
});

test("compareReportFiles: an unreadable file names which file failed", async () => {
  await assert.rejects(
    () => compareReportFiles({ buffer: Buffer.from("not a report"), name: "notes.txt" }, { buffer: Buffer.from("x"), name: "y.txt" }),
    (err: unknown) => err instanceof CompareReportsError && /notes\.txt/.test((err as Error).message),
  );
});

test("comparison PDF HTML: same layout as client reports -- first location under the header, then a section row per country", async () => {
  const c = await compareReportFiles({ buffer: await OLDER(), name: "old.xlsx" }, { buffer: await NEWER(), name: "Twin Crown - Keyword Ranking Report - x.xlsx" });
  const html = buildClientReportHtml({
    clientName: c.clientName,
    clientDomain: c.clientDomain,
    searchEngineDomains: [c.primarySearchDomain!],
    locations: locationsFromRows(c.currentRows, c.sections, c.primarySearchDomain),
    currentRunDate: new Date(c.newer.date),
    previousRunDate: new Date(c.older.date),
    analytics: analyticsFromRows(c.currentRows, c.previousRows),
  });
  assert.ok(html.includes(">Google.ae<"));
  assert.ok(html.includes("1st October 2026") && html.includes("15th September 2026"));
  const body = html.slice(html.indexOf("<tbody>"));
  const sections = [...body.matchAll(/<tr class="location-row">\s*<td>([^<]+)<\/td>/g)].map((m) => m[1]);
  assert.deepEqual(sections, ["Saudi Arabia", "Qatar"]);
  assert.ok(body.indexOf("tcs meters uae") < body.indexOf("Saudi Arabia"));
  assert.ok(body.indexOf("flow meter supplier in qatar") > body.indexOf(">Qatar<"));
});

test("sanitizeComparedRows: re-derives ranks from their text and rejects junk", () => {
  const rows = sanitizeComparedRows([{ keyword: " a ", rankDisplay: "7", rankValue: 999, section: "Qatar" }, { keyword: "b", rankDisplay: "Not in 100" }], "x");
  assert.deepEqual(rows, [
    { keyword: "a", rankValue: 7, rankDisplay: "7", section: "Qatar" },
    { keyword: "b", rankValue: null, rankDisplay: "Not in 100", section: null },
  ]);
  assert.throws(() => sanitizeComparedRows([], "x"), CompareReportsError);
  assert.throws(() => sanitizeComparedRows([{ keyword: "" }], "x"), CompareReportsError);
  assert.throws(() => sanitizeComparedRows("nope", "x"), CompareReportsError);
});

test("POST /api/compare-reports: login required; preview + PDF work end to end; nothing is written to the database", async () => {
  const auth: AuthFixture = await createAuthenticatedSession();
  const app = createApp(neverCalled, "mock");
  const older = await OLDER();
  const newer = await NEWER();
  const countsBefore = await Promise.all([prisma.rankingBaseline.count(), prisma.rankingReport.count(), prisma.rankingRun.count(), prisma.client.count()]);

  const unauthed = await authedRequest(app, "").post("/api/compare-reports/preview").attach("file1", older, "old.xlsx").attach("file2", newer, "new.xlsx");
  assert.equal(unauthed.status, 401);

  const oneFile = await authedRequest(app, auth.cookieHeader).post("/api/compare-reports/preview").attach("file1", older, "old.xlsx");
  assert.equal(oneFile.status, 400);

  const preview = await authedRequest(app, auth.cookieHeader)
    .post("/api/compare-reports/preview")
    .attach("file1", newer, "Twin Crown - Keyword Ranking Report - 15th September 2026 - 1st October 2026.xlsx")
    .attach("file2", older, "Twin Crown - Keyword Ranking Report - 31st August 2026 - 15th September 2026.xlsx");
  assert.equal(preview.status, 200);
  assert.equal(preview.body.older.dateLabel, "15th September 2026");
  assert.equal(preview.body.newer.dateLabel, "1st October 2026");

  const noDates = await authedRequest(app, auth.cookieHeader).post("/api/compare-reports/pdf").send({ currentRows: preview.body.currentRows, previousRows: preview.body.previousRows });
  assert.equal(noDates.status, 400);

  const pdf = await authedRequest(app, auth.cookieHeader)
    .post("/api/compare-reports/pdf")
    .send({
      clientName: "Twin Crown",
      clientDomain: "twincrown.com",
      olderDate: preview.body.older.date,
      newerDate: preview.body.newer.date,
      currentRows: preview.body.currentRows,
      previousRows: preview.body.previousRows,
      sections: preview.body.sections,
      primarySearchDomain: preview.body.primarySearchDomain,
    })
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.match(pdf.headers["content-disposition"], /Twin Crown - Keyword Ranking Report - 15th September 2026 - 1st October 2026\.pdf/);
  assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), "%PDF-");

  const countsAfter = await Promise.all([prisma.rankingBaseline.count(), prisma.rankingReport.count(), prisma.rankingRun.count(), prisma.client.count()]);
  assert.deepEqual(countsAfter, countsBefore, "no baseline, report, run or client was created");
});

test.after(async () => {
  await prisma.$disconnect();
});

// Regression (2026-10-07): report PDFs are text, not scans -- the OCR reader
// couldn't find the "Keyword" header in the app's own (and the agency's) PDFs.
// Round trip: build a real multi-location report PDF, then read it back.
test("parseBaselinePdfText: reads a real report PDF (newest column, sections, website, Google) from its text layer", async () => {
  const { generateClientReportPdf } = await import("../backend/reporting/generateClientReportPdf.js");
  const { parseBaselinePdf } = await import("../backend/baselines/parseBaselinePdf.js");
  const c = await compareReportFiles({ buffer: await OLDER(), name: "old.xlsx" }, { buffer: await NEWER(), name: "Twin Crown - Keyword Ranking Report - x.xlsx" });
  const pdf = await generateClientReportPdf({
    clientName: "Twin Crown",
    clientDomain: "twincrown.com",
    searchEngineDomains: ["google.ae"],
    locations: locationsFromRows(c.currentRows, c.sections, c.primarySearchDomain),
    currentRunDate: new Date(c.newer.date),
    previousRunDate: new Date(c.older.date),
    analytics: analyticsFromRows(c.currentRows, c.previousRows),
  });
  const parsed = await parseBaselinePdf(pdf);
  assert.equal(parsed.baselineDateLabel, "1st October 2026");
  assert.equal(parsed.clientDomain, "twincrown.com");
  assert.equal(parsed.primarySearchDomain, "google.ae");
  assert.deepEqual(parsed.sections, [{ name: "Saudi Arabia", domain: "google.com.sa" }, { name: "Qatar", domain: "google.com.qa" }]);
  const byKeyword = Object.fromEntries(parsed.rows.map((r) => [r.keyword, r]));
  assert.equal(parsed.rows.length, 6);
  assert.equal(byKeyword["oilfield equipment suppliers in dubai"].rankValue, 1);
  assert.equal(byKeyword["flow meter suppliers in saudi arabia"].rankValue, 17);
  assert.equal(byKeyword["flow meter suppliers in saudi arabia"].section, "Saudi Arabia");
  assert.equal(byKeyword["flow meter supplier in qatar"].section, "Qatar");
  assert.equal(byKeyword["tcs meters uae"].section, null);
});

test("compareReportFiles: a flat newer report borrows the older report's location sections", async () => {
  const flatNewer = await reportWorkbook({
    newerLabel: "1st October 2026",
    olderLabel: "15th September 2026",
    rows: [
      ["tcs meters uae", 1, 1],
      ["flow meter suppliers in saudi arabia", 17, 19],
      ["flow meter supplier in qatar", 15, 12],
    ],
  });
  const c = await compareReportFiles({ buffer: await OLDER(), name: "old.xlsx" }, { buffer: flatNewer, name: "new.xlsx" });
  assert.deepEqual(c.sections.map((s) => s.name), ["Saudi Arabia", "Qatar"]);
  assert.equal(c.currentRows.find((r) => r.keyword === "flow meter supplier in qatar")!.section, "Qatar");
  assert.equal(c.currentRows.find((r) => r.keyword === "tcs meters uae")!.section, null);
});
