import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import {
  brandWordsOf,
  classifySerpUrl,
  competitionLabel,
  formatIndianResults,
  guessIntent,
  resultUrl,
  serpSummary,
  volumeBucket,
} from "../backend/reporting/baselineColumns.js";
import { baselineDateLabel, buildBaselineWorkbook, BASELINE_LETTER } from "../backend/reporting/baselineReport.js";
import { countryOfSeDomain, fetchGoogleAdsMetrics, googleAdsConfigured, readKeywordPlannerFile } from "../backend/reporting/keywordPlanner.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// "Baseline Report" (2026-11-10): a new client's first report, the team's Venezia/Altered Images Excel,
// built from the run (ranks, result counts, SERP mix, intent) + Keyword Planner numbers.

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

test("Number of Result uses the Indian format", () => {
  assert.equal(formatIndianResults(61200000), "6,12,00,000 results");
  assert.equal(formatIndianResults(913000), "9,13,000 results");
  assert.equal(formatIndianResults(137), "137 results");
  assert.equal(formatIndianResults(1360), "1,360 results");
  assert.equal(formatIndianResults(null), null);
});

test("Keyword Planner volume -> the team's buckets; competition -> Low/Medium/High/Unknown", () => {
  assert.equal(volumeBucket("0 – 10"), "0 – 10");
  assert.equal(volumeBucket("—"), "0 – 10");
  assert.equal(volumeBucket(null), "0 – 10");
  assert.equal(volumeBucket("10 – 100"), 50);
  assert.equal(volumeBucket("100 – 1K"), 500);
  assert.equal(volumeBucket("1K – 10K"), 5000);
  assert.equal(volumeBucket("10K – 100K"), 50000);
  assert.equal(volumeBucket("90"), 50, "an exact number (Google Ads API) falls into its range");
  assert.equal(volumeBucket("1,300"), 5000);
  assert.equal(volumeBucket("0"), "0 – 10");
  assert.equal(competitionLabel("LOW"), "Low");
  assert.equal(competitionLabel("High"), "High");
  assert.equal(competitionLabel("—"), "Unknown");
  assert.equal(competitionLabel("UNSPECIFIED"), "Unknown");
  assert.equal(competitionLabel(null), "Unknown");
});

test("SERP result: each top-10 URL gets the handover's category", () => {
  const c = (u: string) => classifySerpUrl(new URL(u));
  assert.equal(c("https://www.thewashouse.com.au/"), "Home page");
  assert.equal(c("https://carwash.com.au/en-au/"), "Home page");
  assert.equal(c("https://carwash.com.au/services/hand-car-wash"), "Service page");
  assert.equal(c("https://carwash.com.au/locations/rouse-hill"), "Service page", "suburb/branch pages are Service pages");
  assert.equal(c("https://carwash.com.au/contact-us"), "Contact page");
  assert.equal(c("https://store.com.au/showroom"), "Contact page");
  assert.equal(c("https://www.yelp.com.au/biz/x"), "Directory/Listing");
  assert.equal(c("https://www.westfield.com.au/hornsby/stores/car-wash"), "Directory/Listing", "shopping-centre store pages");
  assert.equal(c("https://www.reddit.com/r/sydney/x"), "Social media", "Reddit counts as Social media");
  assert.equal(c("https://www.youtube.com/watch?v=1"), "Social media");
  assert.equal(c("https://www.quora.com/What-is-x"), "Forum page");
  assert.equal(c("https://site.com/blog/how-to-wash-a-car"), "Blog page");
  assert.equal(c("https://site.com/docs/brochure.pdf"), "PDF");
  assert.equal(c("https://shop.com/products/car-shampoo"), "Product page");
  assert.equal(c("https://www.amazon.com.au/dp/B0001"), "Product page");
});

test("SERP result: a Google redirect falls back to its breadcrumb; the line adds up to the results counted", () => {
  assert.equal(resultUrl({ url: "https://google.com.au/goto?url=CAES", breadcrumb: "https://www.site.com.au › contact" })?.toString(), "https://www.site.com.au/contact");
  assert.equal(resultUrl({ url: "https://google.com.au/goto?url=CAES", breadcrumb: "Site Studio" }), null);
  const s = serpSummary([
    { url: "https://a.com.au/" },
    { url: "https://b.com.au/" },
    { url: "https://c.com.au/car-wash" },
    { url: "https://c.com.au/rouse-hill" },
    { url: "https://www.yelp.com.au/x" },
    { url: "https://www.truelocal.com.au/x" },
    { url: "https://www.yellowpages.com.au/x" },
    { url: "https://www.hotfrog.com.au/x" },
    { url: "https://www.facebook.com/x" },
    { url: "https://www.instagram.com/x" },
  ]);
  assert.equal(s?.text, "2 Home page, 2 Service page, 4 Directory/Listing, 2 Social media");
  assert.equal(serpSummary([]), null);
});

test("Intent: one word, by the handover's rules", () => {
  assert.equal(guessIntent("car wash kellyville", null), "Transactional");
  assert.equal(guessIntent("best car wash sydney", null), "Commercial");
  assert.equal(guessIntent("how to wash a car", null), "Informational");
  assert.equal(guessIntent("rouse hill town centre car wash", null), "Navigational");
  assert.equal(guessIntent("the washouse rouse hill", null, brandWordsOf("thewashouse.com.au")), "Navigational");
  assert.equal(guessIntent("professional product photography", ["Blog page", "Blog page", "Blog page", "Blog page", "Blog page", "Blog page", "Service page", "Home page"]), "Informational");
});

test("Keyword Planner download: the UTF-16 tab-separated .csv and an .xlsx are both read", async () => {
  const csv = [
    "Keyword Stats 2026-11-10 at 10_00_00",
    "10 November 2025 - 31 October 2026",
    "Keyword\tCurrency\tAvg. monthly searches\tThree month change\tYoY change\tCompetition\tCompetition (indexed value)",
    "car wash rouse hill\tINR\t100 – 1K\t0%\t0%\tLow\t12",
    "rouse hill car wash\tINR\t10 – 100\t0%\t0%\t\t",
  ].join("\r\n");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]);
  const fromCsv = await readKeywordPlannerFile(utf16, "Keyword Stats 2026-11-10.csv");
  assert.deepEqual(fromCsv, [
    { keyword: "car wash rouse hill", avgMonthlySearches: "100 – 1K", competition: "Low" },
    { keyword: "rouse hill car wash", avgMonthlySearches: "10 – 100", competition: null },
  ]);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Keyword Stats"]);
  ws.addRow(["Keyword", "Avg. monthly searches", "Competition"]);
  ws.addRow(["car wash kellyville", "1K – 10K", "High"]);
  const fromXlsx = await readKeywordPlannerFile(Buffer.from(await wb.xlsx.writeBuffer()), "planner.xlsx");
  assert.deepEqual(fromXlsx, [{ keyword: "car wash kellyville", avgMonthlySearches: "1K – 10K", competition: "High" }]);

  await assert.rejects(readKeywordPlannerFile(Buffer.from("a,b\n1,2"), "x.csv"), /doesn't look like a Keyword Planner download/);
});

test("Google Ads API: country from the search domain; the request and close variants (merged keywords)", async () => {
  assert.equal(countryOfSeDomain("google.com.au"), "AU");
  assert.equal(countryOfSeDomain("google.co.in"), "IN");
  assert.equal(countryOfSeDomain("google.ae"), "AE");
  assert.equal(googleAdsConfigured({}), false);
  const env = {
    GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
    GOOGLE_ADS_CLIENT_ID: "cid",
    GOOGLE_ADS_CLIENT_SECRET: "sec",
    GOOGLE_ADS_REFRESH_TOKEN: "ref",
    GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333",
  } as NodeJS.ProcessEnv;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok" }));
    return new Response(
      JSON.stringify({ results: [{ text: "car wash rouse hill", closeVariants: ["rouse hill car wash"], keywordMetrics: { avgMonthlySearches: "320", competition: "LOW" } }] }),
    );
  }) as typeof fetch;
  const out = await fetchGoogleAdsMetrics(["car wash rouse hill", "rouse hill car wash"], "AU", { fetchImpl, env });
  assert.deepEqual(out, [
    { keyword: "car wash rouse hill", avgMonthlySearches: "320", competition: "LOW" },
    { keyword: "rouse hill car wash", avgMonthlySearches: "320", competition: "LOW" },
  ]);
  assert.match(calls[1].url, /\/customers\/1234567890:generateKeywordHistoricalMetrics$/);
  const headers = calls[1].init.headers as Record<string, string>;
  assert.equal(headers["login-customer-id"], "1112223333");
  assert.equal(headers["developer-token"], "dev");
  const body = JSON.parse(String(calls[1].init.body));
  assert.deepEqual(body.geoTargetConstants, ["geoTargetConstants/2036"]);
  assert.equal(body.keywordPlanNetwork, "GOOGLE_SEARCH");
});

async function readBack(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const rows: unknown[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) rows.push((ws.getRow(r).values as unknown[]).slice(1));
  return { ws, rows, images: ws.getImages().length, merges: (ws.model as unknown as { merges: string[] }).merges };
}

test("buildBaselineWorkbook: title, letter, headers with the date, rows sorted by rank and 'Not in 100' last", async () => {
  assert.equal(baselineDateLabel(new Date("2026-11-09T05:00:00Z")), "09th Nov 2026");
  const buffer = await buildBaselineWorkbook({
    domain: "veneziadesigns.com",
    reportDate: new Date("2026-11-09T05:00:00Z"),
    rows: [
      { keyword: "kitchen design", rankValue: null, rankDisplay: "Not in 100", volume: 5000, competition: "High", results: "1,360 results", serp: "10 Service page", intent: "Transactional" },
      { keyword: "kitchen contractors dubai", rankValue: 2, rankDisplay: "2", volume: 50, competition: "High", results: "137 results", serp: "1 Home page, 9 Service page", intent: "Transactional" },
    ],
  });
  const { rows, images, merges } = await readBack(buffer);
  assert.equal(rows[0][0], "Client Keyword Baseline Report\nveneziadesigns.com \n09th Nov 2026");
  assert.equal(rows[1][0], BASELINE_LETTER);
  assert.match(BASELINE_LETTER, /Caahill Murzello\.$/);
  assert.deepEqual(rows[2], ["Keywords", "Avg. Monthly Searches", "Competition", "Number of Result", "SERP result", "Intent", "09th Nov 2026 ranking"]);
  assert.deepEqual(rows[3], ["kitchen contractors dubai", 50, "High", "137 results", "1 Home page, 9 Service page", "Transactional", 2]);
  assert.deepEqual(rows[4], ["kitchen design", 5000, "High", "1,360 results", "10 Service page", "Transactional", "Not in 100"]);
  assert.equal(images, 1, "the logo");
  assert.deepEqual([...merges].sort(), ["A1:G1", "A2:G2"]);
});

// ---------------------------------------------------------------- end to end

function serpAnswer(urls: string[], results: number) {
  return {
    status_code: 20000,
    tasks: [{ status_code: 20000, result: [{ se_results_count: results, items: urls.map((url, i) => ({ type: "organic", rank_group: i + 1, url })) }] }],
  };
}

async function setup() {
  const sentCalls: { excelPdfFilename?: string; excelPdfBuffer?: Buffer }[] = [];
  const app = createApp(neverCalled, "mock", undefined, { sendEmail: createMockEmailSender((p) => sentCalls.push(p)) });
  const api = authedRequest(app, auth.cookieHeader);
  const client = await prisma.client.create({ data: { name: `Baseline ${randomUUID().slice(0, 8)}`, domain: "thewashouse.com.au", workspaceId: auth.workspace.id } });
  const run = await prisma.rankingRun.create({
    data: { clientId: client.id, sourceFilename: "washouse.xlsx", sourceFilePath: "x", totalRows: 2, status: "COMPLETED", completedAt: new Date("2026-11-14T08:00:00Z") },
  });
  const rows = [
    { keyword: "car wash rouse hill", rank: 4, urls: ["https://a.com.au/", "https://www.yelp.com.au/x", "https://c.com.au/car-wash", "https://www.thewashouse.com.au/"], results: 137 },
    { keyword: "rouse hill hand car wash", rank: null, urls: ["https://site.com/blog/x"], results: 252000 },
  ];
  for (const [i, r] of rows.entries()) {
    const row = await prisma.rankingRow.create({
      data: {
        runId: run.id, rowUid: randomUUID(), sourceRowNumber: i + 2, keyword: r.keyword, targetUrl: "*thewashouse.*", locationName: "Australia", seDomain: "google.com.au", languageName: "English",
        status: "COMPLETED", rankValue: r.rank, rankDisplay: r.rank === null ? "Not in 100" : String(r.rank),
      },
    });
    await prisma.rankingRowAttempt.create({
      data: { rankingRowId: row.id, attemptNumber: 1, requestPayload: {}, httpStatus: 200, dataforseoStatusCode: 20000, rawResponse: serpAnswer(r.urls, r.results), outcome: "SUCCESS" },
    });
  }
  const report = await prisma.rankingReport.create({
    data: {
      clientId: client.id, runId: run.id, status: ReportStatus.PENDING_APPROVAL, reportDate: new Date("2026-11-14T09:00:00Z"), analyticsJson: {},
      emailSubject: "The Washouse Keyword Baseline Report", emailBody: "Hi", resolvedRecipients: ["client@example.com"],
    },
  });
  const cleanup = async () => {
    await prisma.keywordMetric.deleteMany({ where: { clientId: client.id } });
    const baselines = await prisma.rankingBaseline.findMany({ where: { clientId: client.id } });
    await prisma.rankingBaselineRow.deleteMany({ where: { baselineId: { in: baselines.map((b) => b.id) } } });
    await prisma.rankingBaseline.deleteMany({ where: { clientId: client.id } });
    await prisma.notification.deleteMany({ where: { clientId: client.id } }).catch(() => {});
    await prisma.reportSend.deleteMany({ where: { reportId: report.id } });
    await prisma.rankingReport.deleteMany({ where: { clientId: client.id } });
    await prisma.rankingRowAttempt.deleteMany({ where: { rankingRow: { runId: run.id } } });
    await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
    await prisma.rankingRun.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  };
  return { api, client, report, sentCalls, cleanup };
}

test("baseline report: Keyword Planner upload, preview, and the send attaches the Baseline Excel instead of the PDF", async () => {
  const t = await setup();
  try {
    // Picked on the report.
    const picked = await t.api.patch(`/api/reports/${t.report.id}`).send({ attachmentSource: "baseline" });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));

    const info0 = await t.api.get(`/api/reports/${t.report.id}/baseline-report/info`);
    assert.equal(info0.body.ready, true, JSON.stringify(info0.body));
    assert.deepEqual(info0.body.missingVolumes, ["car wash rouse hill", "rouse hill hand car wash"]);
    assert.deepEqual(info0.body.missingSerp, []);
    assert.equal(info0.body.country, "AU");
    assert.equal(info0.body.googleAdsAvailable, false);

    const bad = await t.api.post(`/api/reports/${t.report.id}/baseline-report/keyword-planner`).attach("file", Buffer.from("hello"), "x.csv");
    assert.equal(bad.status, 422);

    const csv = "Keyword,Avg. monthly searches,Competition\ncar wash rouse hill,100 – 1K,Low\nhand car wash rouse hill,10 – 100,\n";
    const up = await t.api.post(`/api/reports/${t.report.id}/baseline-report/keyword-planner`).attach("file", Buffer.from(csv), "Keyword Stats.csv");
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.saved, 2);
    assert.deepEqual(up.body.missingVolumes, []);
    assert.deepEqual(up.body.merged, [{ keyword: "rouse hill hand car wash", usedFiguresOf: "hand car wash rouse hill" }], "Keyword Planner merged the same words in another order");

    const google = await t.api.post(`/api/reports/${t.report.id}/baseline-report/google-ads`);
    assert.equal(google.status, 503, "not set up yet");

    const sent = await t.api.post(`/api/reports/${t.report.id}/approve-and-send`).send({});
    assert.equal(sent.body.outcome, "SENT", JSON.stringify(sent.body));
    assert.equal(t.sentCalls.length, 1);
    assert.equal(t.sentCalls[0].excelPdfFilename, `${t.client.name} - Baseline Report.xlsx`);
    const { rows } = await readBack(t.sentCalls[0].excelPdfBuffer!);
    assert.equal(rows[0][0], "Client Keyword Baseline Report\nthewashouse.com.au \n14th Nov 2026");
    assert.deepEqual(rows[3], ["car wash rouse hill", 500, "Low", "137 results", "2 Home page, 1 Service page, 1 Directory/Listing", "Transactional", 4]);
    assert.deepEqual(rows[4], ["rouse hill hand car wash", 50, "Unknown", "2,52,000 results", "1 Blog page", "Transactional", "Not in 100"]);

    // Baselines follow the usual rule (only a verified-Excel report's ranks become one) -- nothing special here.
    assert.equal((await prisma.rankingReport.findUniqueOrThrow({ where: { id: t.report.id } })).status, "SENT");
  } finally {
    await t.cleanup();
  }
});
