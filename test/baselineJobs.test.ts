import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { parseRankingExcel } from "../backend/excel/parser.js";
import { keywordTemplateBuffer, keywordsFromWorkbook, parseKeywordText, BASELINE_COUNTRIES } from "../backend/reporting/baselineJobs.js";
import { createAuthenticatedSession, type AuthFixture } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// "Baseline Report" tab on Domain Intelligence (2026-11-13): typed keywords -> a run -> the Baseline Excel.

let auth: AuthFixture;
const savedAdsEnv: Record<string, string | undefined> = {};
test.before(async () => {
  auth = await createAuthenticatedSession();
  // Never the real Google Ads API from a test (a dev laptop's .env may have the keys).
  for (const k of Object.keys(process.env).filter((k) => k.startsWith("GOOGLE_ADS_"))) {
    savedAdsEnv[k] = process.env[k];
    delete process.env[k];
  }
});
test.after(async () => {
  Object.assign(process.env, savedAdsEnv);
  const clients = await prisma.client.findMany({ where: { workspaceId: auth.workspace.id }, select: { id: true } });
  const ids = clients.map((c) => c.id);
  await prisma.baselineJob.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.keywordMetric.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.rankingRowAttempt.deleteMany({ where: { rankingRow: { run: { clientId: { in: ids } } } } });
  await prisma.rankingRow.deleteMany({ where: { run: { clientId: { in: ids } } } });
  await prisma.rankingRun.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await auth.cleanup();
  await prisma.$disconnect();
});

test("keyword list: one per line (commas/tabs too), trimmed, repeats and blanks dropped", () => {
  assert.deepEqual(parseKeywordText(" kitchen design \n\nModular Kitchen Dubai\nmodular kitchen dubai, luxury kitchens\tbathroom  renovation\r\n"), [
    "kitchen design",
    "Modular Kitchen Dubai",
    "luxury kitchens",
    "bathroom renovation",
  ]);
});

test("keyword Excel: the Keywords column is used, else the first column", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Volume", "Keyword"]);
  ws.addRow([50, "kitchen design"]);
  ws.addRow([500, "kitchen design"]);
  ws.addRow([5, "walk in closet dubai"]);
  assert.deepEqual(await keywordsFromWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), ["kitchen design", "walk in closet dubai"]);

  const plain = new ExcelJS.Workbook();
  plain.addWorksheet("x").addRows([["car wash rouse hill"], ["car detailing rouse hill"]]);
  assert.deepEqual(await keywordsFromWorkbook(Buffer.from(await plain.xlsx.writeBuffer())), ["car wash rouse hill", "car detailing rouse hill"]);
});

test("the generated run file is read by the normal run parser: every keyword Pending, the right Google and country", async () => {
  const buffer = await keywordTemplateBuffer(["kitchen design", "luxury kitchens dubai"], "veneziadesigns.com", BASELINE_COUNTRIES.ae);
  const { rows, rowErrors } = await parseRankingExcel(buffer, { clientId: "x" });
  assert.equal(rowErrors.length, 0);
  assert.equal(rows.length, 2);
  const r = rows[0] as Record<string, unknown>;
  assert.equal(r.keyword, "kitchen design");
  assert.equal(r.status, "PENDING");
  assert.equal(r.seDomain, "google.ae");
  assert.equal(r.locationName, "United Arab Emirates");
  assert.equal(r.targetUrl, "*veneziadesigns.*");
});

test("baseline job: start from pasted keywords, the run checks them, then the Baseline Excel downloads", async () => {
  // A fake rank checker: the client's site at #3 for "kitchen design", nowhere for the other keyword.
  const fakeCall: CallDataForSeoFn = async (payload) => {
    const p = payload as unknown as { keyword?: string } | { keyword?: string }[];
    const keyword = String((Array.isArray(p) ? p[0]?.keyword : p.keyword) ?? "");
    const urls = keyword === "kitchen design" ? ["https://a.ae/", "https://b.ae/blog/x", "https://veneziadesigns.com/kitchens/"] : ["https://a.ae/", "https://www.instagram.com/x"];
    return {
      httpStatus: 200,
      body: {
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            result: [
              {
                keyword,
                se_results_count: null,
                pages_count: 10,
                items: urls.map((url, i) => ({ type: "organic", rank_group: i + 1, rank_absolute: i + 1, url, domain: new URL(url).hostname })),
              },
            ],
          },
        ],
      },
    };
  };
  const app = createApp(fakeCall, "mock");
  const api = authedRequest(app, auth.cookieHeader);

  const bad = await api.post("/api/baseline-jobs").field("workspaceId", auth.workspace.id).field("clientName", "Venezia Test").field("websiteUrl", "").field("country", "ae").field("keywords", "x");
  assert.equal(bad.status, 400);

  const started = await api
    .post("/api/baseline-jobs")
    .field("workspaceId", auth.workspace.id)
    .field("clientName", "Venezia Test")
    .field("websiteUrl", "https://www.veneziadesigns.com/")
    .field("country", "ae")
    .field("keywords", "kitchen design\nwardrobe renovation\nkitchen design");
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.total, 2, "the repeat was dropped");
  assert.equal(started.body.country, "AE");

  let job = started.body;
  for (let i = 0; i < 60 && job.state === "checking"; i++) {
    await new Promise((r) => setTimeout(r, 250));
    job = (await api.get(`/api/baseline-jobs/${job.id}`)).body;
  }
  assert.equal(job.state, "ready", JSON.stringify(job));
  assert.equal(job.volumes, "not_set_up");
  assert.equal(job.ranked, 1);

  const list = await api.get(`/api/baseline-jobs?workspaceId=${auth.workspace.id}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.some((j: { id: string }) => j.id === job.id));

  // The client is a Domain Intelligence prospect -- not on the ranking side's client lists.
  const client = await prisma.client.findFirstOrThrow({ where: { workspaceId: auth.workspace.id, name: "Venezia Test" } });
  assert.equal(client.kind, "domain");

  // Keyword Planner download instead of Google Ads.
  const planner = "Keyword Stats\nUnited Arab Emirates\nKeyword,Currency,Avg. monthly searches,Three month change,YoY change,Competition,Competition (indexed value)\nkitchen design,AED,1K – 10K,0%,0%,High,80\n";
  const up = await api.post(`/api/baseline-jobs/${job.id}/keyword-planner`).attach("file", Buffer.from(planner), "planner.csv");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.volumes, "fetched");

  const dl = await api.get(`/api/baseline-jobs/${job.id}/download`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(dl.status, 200);
  assert.match(String(dl.headers["content-disposition"]), /Venezia%20Test%20-%20Baseline%20Report\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(dl.body as Buffer);
  const ws = wb.worksheets[0];
  const title = String(ws.getRow(1).getCell(1).value);
  assert.match(title, /veneziadesigns\.com/);
  const rows = [4, 5].map((r) => ws.getRow(r).values as unknown[]);
  assert.equal(rows[0][1], "kitchen design");
  assert.equal(rows[0][2], 5000);
  assert.equal(rows[0][3], "High");
  assert.equal(rows[0][7], 3);
  assert.equal(rows[1][1], "wardrobe renovation");
  assert.equal(rows[1][7], "Not in 100");

  // Another workspace can't see it.
  const other = await createAuthenticatedSession();
  try {
    const stranger = authedRequest(app, other.cookieHeader);
    assert.equal((await stranger.get(`/api/baseline-jobs/${job.id}`)).status, 404);
    assert.equal((await stranger.get(`/api/baseline-jobs?workspaceId=${auth.workspace.id}`)).status, 403);
  } finally {
    await other.cleanup();
  }
});
