import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import {
  CompareReportsError,
  analyticsFromRows,
  compareRankingFiles,
  locationsFromRows,
  sanitizeComparedRows,
} from "../backend/reporting/compareReportFiles.js";
import { clientNameFromFileName } from "../backend/reporting/readRankingsExcel.js";
import { buildClientReportHtml } from "../backend/reporting/generateClientReportPdf.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// "Compare Reports" tab: two rankings Excels (each with a user-picked date) in,
// one comparison PDF out. Stateless -- these tests also assert nothing is
// written to the database.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Compare Reports must never call DataForSEO");
};

const HEADERS = ["Keywords", "Full URL", "URL", "Concatenate", "Location", "Domain", "Language", "Status", "Ranks", "Ranking url"];
type Kw = [keyword: string, location: string, domain: string, rank: string | number, status?: string];

/** A run's rankings Excel, optionally after a formatted report sheet (like the agency's "…_FINAL.xlsx"). */
async function rankingsWorkbook(rows: Kw[], opts: { site?: string; withReportSheetFirst?: boolean } = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  if (opts.withReportSheetFirst) {
    const report = workbook.addWorksheet("Ranking");
    report.addRow(["Client Keyword Ranking Report"]);
    report.addRow(["Keyword", "15th September 2026", "31st August 2026"]);
    report.addRow(["should not be read", 99, 99]);
  }
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(HEADERS);
  const site = opts.site ?? "https://www.twincrown.com/";
  for (const [keyword, location, domain, rank, status] of rows) {
    sheet.addRow([keyword, site, site, `${keyword}${site}`, location, domain, "English", status ?? "Completed", rank, ""]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const SEP15: Kw[] = [
  ["tcs meters uae", "United Arab Emirates", "google.ae", 1],
  ["oilfield equipment suppliers in dubai", "United Arab Emirates", "google.ae", 3],
  ["flow meter suppliers", "Saudi Arabia", "google.com.sa", 19],
  ["pump suppliers in saudi arabia", "Saudi Arabia", "google.com.sa", "Not in 100"],
  ["flow meter suppliers", "Qatar", "google.com.qa", 12], // same keyword, another country
  ["dropped keyword", "United Arab Emirates", "google.ae", 40],
];
const SEP30: Kw[] = [
  ["tcs meters uae", "United Arab Emirates", "google.ae", 1],
  ["oilfield equipment suppliers in dubai", "United Arab Emirates", "google.ae", 1],
  ["flow meter suppliers", "Saudi Arabia", "google.com.sa", 17],
  ["pump suppliers in saudi arabia", "Saudi Arabia", "google.com.sa", 45],
  ["flow meter suppliers", "Qatar", "google.com.qa", 20],
  ["brand new keyword", "United Arab Emirates", "google.ae", 8],
];
const D = (iso: string) => new Date(iso + "T00:00:00.000Z");

test("clientNameFromFileName: strips dates, FINAL / rankings and underscores", () => {
  assert.equal(clientNameFromFileName("all_bathrooms_and_tiling_15th_Sep_FINAL.xlsx"), "All Bathrooms and Tiling");
  assert.equal(clientNameFromFileName("Mr Whirly Bird - Final rankings.xlsx"), "Mr Whirly Bird");
  assert.equal(clientNameFromFileName("Twin Crown 30th September 2026 rankings (1).xlsx"), "Twin Crown");
  assert.equal(clientNameFromFileName("15th_Sep.xlsx"), "Client");
});

test("compareRankingFiles: later picked date is current whichever box it's in; countries kept apart", async () => {
  const older = { buffer: await rankingsWorkbook(SEP15), name: "Twin Crown 15 Sep.xlsx", date: D("2026-09-15") };
  const newer = { buffer: await rankingsWorkbook(SEP30), name: "Twin Crown - Final rankings.xlsx", date: D("2026-09-30") };
  for (const [a, b] of [[older, newer], [newer, older]]) {
    const c = await compareRankingFiles(a, b);
    assert.equal(c.older.dateLabel, "15th September 2026");
    assert.equal(c.newer.dateLabel, "30th September 2026");
    assert.equal(c.clientName, "Twin Crown");
    assert.equal(c.clientDomain, "twincrown.com");
    assert.equal(c.newer.sheetName, "Sheet1");
    // "flow meter suppliers" is matched per country (Saudi 19->17, Qatar 12->20), not merged.
    assert.deepEqual(c.summary, { matched: 5, onlyInNewer: 1, onlyInOlder: 1, improved: 3, declined: 1, unchanged: 1 });
  }
});

test("compareRankingFiles: a workbook with a report sheet before the rankings sheet reads the rankings sheet", async () => {
  const c = await compareRankingFiles(
    { buffer: await rankingsWorkbook(SEP15, { withReportSheetFirst: true }), name: "a.xlsx", date: D("2026-09-15") },
    { buffer: await rankingsWorkbook(SEP30, { withReportSheetFirst: true }), name: "b.xlsx", date: D("2026-09-30") },
  );
  assert.equal(c.older.sheetName, "Sheet1");
  assert.ok(!c.currentRows.some((r) => r.keyword === "should not be read"));
});

test("compareRankingFiles: missing or identical dates are refused with a plain message", async () => {
  const buf = await rankingsWorkbook(SEP15);
  await assert.rejects(
    compareRankingFiles({ buffer: buf, name: "a.xlsx", date: null }, { buffer: buf, name: "b.xlsx", date: D("2026-09-30") }),
    (err: unknown) => err instanceof CompareReportsError && /Pick the date .*"a\.xlsx"/.test(err.message),
  );
  await assert.rejects(
    compareRankingFiles({ buffer: buf, name: "a.xlsx", date: D("2026-09-30") }, { buffer: buf, name: "b.xlsx", date: D("2026-09-30") }),
    (err: unknown) => err instanceof CompareReportsError && /Both files are dated 30th September 2026/.test(err.message),
  );
});

test("compareRankingFiles: a file that isn't a rankings Excel names which file failed", async () => {
  const notRankings = new ExcelJS.Workbook();
  notRankings.addWorksheet("Ranking").addRow(["Keyword", "15th September 2026"]);
  await assert.rejects(
    compareRankingFiles(
      { buffer: Buffer.from(await notRankings.xlsx.writeBuffer()), name: "report.xlsx", date: D("2026-09-15") },
      { buffer: await rankingsWorkbook(SEP30), name: "new.xlsx", date: D("2026-09-30") },
    ),
    (err: unknown) => err instanceof CompareReportsError && /"report\.xlsx".*No rankings sheet found/.test(err.message),
  );
  await assert.rejects(
    compareRankingFiles(
      { buffer: Buffer.from("%PDF-1.4 not excel"), name: "report.pdf", date: D("2026-09-15") },
      { buffer: await rankingsWorkbook(SEP30), name: "new.xlsx", date: D("2026-09-30") },
    ),
    (err: unknown) => err instanceof CompareReportsError && /"report\.pdf".*isn't an Excel/.test(err.message),
  );
});

test("compareRankingFiles: blank ranks, skipped rows and different websites are warned about, not blocking", async () => {
  const c = await compareRankingFiles(
    { buffer: await rankingsWorkbook(SEP15, { site: "https://other-site.com/" }), name: "old.xlsx", date: D("2026-09-15") },
    {
      buffer: await rankingsWorkbook([...SEP30, ["pending keyword", "United Arab Emirates", "google.ae", "", "Pending"], ["bad status", "United Arab Emirates", "google.ae", 5, "Done"]]),
      name: "new.xlsx",
      date: D("2026-09-30"),
    },
  );
  assert.equal(c.newer.missingRankCount, 1);
  assert.equal(c.newer.keywordCount, 7);
  assert.equal(c.warnings.length, 3);
  assert.match(c.warnings[0], /1 keyword in "new\.xlsx" \(30th September 2026\) has no rank/);
  assert.match(c.warnings[1], /1 row in "new\.xlsx" skipped \(row 9\): Unrecognized Status value: "Done"/);
  assert.match(c.warnings[2], /different websites: other-site\.com and twincrown\.com/);
});

test("comparison PDF HTML: first country under the header, then a section row per further country", async () => {
  const c = await compareRankingFiles(
    { buffer: await rankingsWorkbook(SEP15), name: "old.xlsx", date: D("2026-09-15") },
    { buffer: await rankingsWorkbook(SEP30), name: "new.xlsx", date: D("2026-09-30") },
  );
  const locations = locationsFromRows(c.currentRows, c.previousRows);
  assert.deepEqual(locations.order, ["United Arab Emirates|google.ae", "Saudi Arabia|google.com.sa", "Qatar|google.com.qa"]);
  const html = buildClientReportHtml({
    clientName: "Twin Crown",
    clientDomain: "twincrown.com",
    searchEngineDomains: ["google.ae"],
    locations,
    currentRunDate: D("2026-09-30"),
    previousRunDate: D("2026-09-15"),
    analytics: analyticsFromRows(c.currentRows, c.previousRows),
  });
  const saudi = html.indexOf("Saudi Arabia");
  const qatar = html.indexOf("Qatar");
  assert.ok(html.indexOf("tcs meters uae") < saudi && saudi < qatar, "UAE rows, then Saudi section, then Qatar section");
  const saudiBlock = html.slice(saudi, qatar);
  // Current (30 Sep) column first, then previous (15 Sep).
  assert.match(saudiBlock, /flow meter suppliers[\s\S]*17[\s\S]*19/);
  assert.match(html.slice(qatar), /flow meter suppliers[\s\S]*20[\s\S]*12/);
});

test("sanitizeComparedRows: re-derives ranks from their text and rejects junk", () => {
  const rows = sanitizeComparedRows(
    [
      { keyword: " a ", rankDisplay: "5", rankValue: 1, location: "UAE|google.ae" },
      { keyword: "b", rankDisplay: "Not in 100", rankValue: 3, location: "UAE|google.ae" },
    ],
    "Newer",
  );
  assert.deepEqual(rows, [
    { keyword: "a", rankValue: 5, rankDisplay: "5", location: "UAE|google.ae" },
    { keyword: "b", rankValue: null, rankDisplay: "Not in 100", location: "UAE|google.ae" },
  ]);
  assert.throws(() => sanitizeComparedRows([], "Newer"), CompareReportsError);
  assert.throws(() => sanitizeComparedRows([{ keyword: "" , location: "x"}], "Newer"), CompareReportsError);
  assert.throws(() => sanitizeComparedRows([{ keyword: "a" }], "Newer"), CompareReportsError);
});

test("POST /api/compare-reports: login required; preview + PDF work end to end; nothing is written to the database", async () => {
  const auth: AuthFixture = await createAuthenticatedSession();
  const app = createApp(neverCalled, "mock");
  const older = await rankingsWorkbook(SEP15);
  const newer = await rankingsWorkbook(SEP30);
  // Counted for THIS test's client only: test files run in parallel, and other files create and delete
  // their own clients/runs meanwhile, so whole-table counts made this check fail at random.
  const twinCrown = { OR: [{ name: { contains: "Twin Crown" } }, { domain: { contains: "twincrown" } }] };
  const countTwinCrown = () =>
    Promise.all([
      prisma.client.count({ where: twinCrown }),
      prisma.rankingBaseline.count({ where: { client: twinCrown } }),
      prisma.rankingRun.count({ where: { client: twinCrown } }),
      prisma.rankingReport.count({ where: { run: { client: twinCrown } } }),
    ]);
  const countsBefore = await countTwinCrown();

  const unauthed = await authedRequest(app, "").post("/api/compare-reports/preview").attach("file1", older, "old.xlsx").attach("file2", newer, "new.xlsx");
  assert.equal(unauthed.status, 401);

  const oneFile = await authedRequest(app, auth.cookieHeader).post("/api/compare-reports/preview").attach("file1", older, "old.xlsx");
  assert.equal(oneFile.status, 400);

  const noDate = await authedRequest(app, auth.cookieHeader)
    .post("/api/compare-reports/preview")
    .field("date1", "2026-09-30")
    .attach("file1", newer, "new.xlsx")
    .attach("file2", older, "old.xlsx");
  assert.equal(noDate.status, 422);
  assert.match(noDate.body.error, /Pick the date .*"old\.xlsx"/);

  const preview = await authedRequest(app, auth.cookieHeader)
    .post("/api/compare-reports/preview")
    .field("date1", "2026-09-30")
    .field("date2", "2026-09-15")
    .attach("file1", newer, "Twin Crown - Final rankings.xlsx")
    .attach("file2", older, "Twin Crown 15th Sep.xlsx");
  assert.equal(preview.status, 200);
  assert.equal(preview.body.older.dateLabel, "15th September 2026");
  assert.equal(preview.body.newer.dateLabel, "30th September 2026");
  assert.equal(preview.body.clientName, "Twin Crown");

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
    })
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.match(pdf.headers["content-disposition"], /Twin Crown - Keyword Ranking Report - 15th September 2026 - 30th September 2026\.pdf/);
  assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), "%PDF-");

  assert.deepEqual(await countTwinCrown(), countsBefore, "no client, baseline, run or report was created");
});

test.after(async () => {
  await prisma.$disconnect();
});
