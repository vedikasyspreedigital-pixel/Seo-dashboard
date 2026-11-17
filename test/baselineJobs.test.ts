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
import { createMockEmailSender } from "../backend/reporting/mockEmailSender.js";
import type { SendEmailParams } from "../backend/reporting/emailSender.js";

// "Baseline Report" tab on Domain Intelligence (2026-11-13): typed keywords -> a run -> the Baseline Excel.

let auth: AuthFixture;
const savedAdsEnv: Record<string, string | undefined> = {};
test.before(async () => {
  auth = await createAuthenticatedSession();
  // Never the real Google Ads API from a test (a dev laptop's .env may have the keys).
  for (const k of Object.keys(process.env).filter((k) => k.startsWith("GOOGLE_ADS_") || k.startsWith("GEMINI_") || k === "ANTHROPIC_API_KEY")) {
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
  const sent: SendEmailParams[] = [];
  const app = createApp(fakeCall, "mock", undefined, { sendEmail: createMockEmailSender((p) => sent.push(p)) });
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
  await wb.xlsx.load(dl.body as unknown as ArrayBuffer);
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

  // On-screen preview of the client copy: the 5 client columns, ranked first.
  const pv = await api.get(`/api/baseline-jobs/${job.id}/preview`);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.domain, "veneziadesigns.com");
  assert.deepEqual(pv.body.headers.slice(0, 4), ["Keywords", "Avg. Monthly Searches", "Competition", "Intent"]);
  assert.equal(pv.body.headers.length, 5);
  assert.deepEqual(pv.body.rows[0].slice(0, 3).concat(pv.body.rows[0][4]), ["kitchen design", 5000, "High", 3]);
  assert.equal(pv.body.rows[1][4], "Not in 100");

  // Email to the new client: To / CC / ClickUp task, the client copy attached, ONCE.
  assert.equal(job.email.state, "not_sent");
  assert.equal(job.email.defaultSubject, "Venezia Test - Keyword Baseline Report");
  const noTo = await api.post(`/api/baseline-jobs/${job.id}/send`).send({ to: "", clickupTask: "86c1abcde" });
  assert.equal(noTo.status, 400);
  const badTo = await api.post(`/api/baseline-jobs/${job.id}/send`).send({ to: "not-an-email", clickupTask: "86c1abcde" });
  assert.equal(badTo.status, 400);
  const noTask = await api.post(`/api/baseline-jobs/${job.id}/send`).send({ to: "owner@venezia.ae", clickupTask: "" });
  assert.equal(noTask.status, 400);
  const badTask = await api.post(`/api/baseline-jobs/${job.id}/send`).send({ to: "owner@venezia.ae", clickupTask: "https://evil.example.com/t/86c1abcde" });
  assert.equal(badTask.status, 400);
  assert.equal(sent.length, 0, "nothing went out for a bad form");

  const ok = await api
    .post(`/api/baseline-jobs/${job.id}/send`)
    .send({ to: "owner@venezia.ae, Owner@venezia.ae", cc: "seo@syspree.com", clickupTask: "https://app.clickup.com/t/86c1abcde", subject: "", body: "" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.email.state, "sent");
  assert.deepEqual(ok.body.email.to, ["owner@venezia.ae"]);
  assert.deepEqual(ok.body.email.cc, ["seo@syspree.com"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].clickupTaskUrl, "https://app.clickup.com/t/86c1abcde");
  assert.equal(sent[0].subject, "Venezia Test - Keyword Baseline Report");
  assert.match(sent[0].bodyText, /Greetings from SySpree/);
  assert.equal(sent[0].excelPdfFilename, "Venezia Test - Baseline Report.xlsx");
  const att = new ExcelJS.Workbook();
  await att.xlsx.load(sent[0].excelPdfBuffer as unknown as ArrayBuffer);
  const attHeader = (att.worksheets[0].getRow(3).values as unknown[]).slice(1);
  assert.deepEqual(attHeader.slice(0, 4), ["Keywords", "Avg. Monthly Searches", "Competition", "Intent"], "the client copy: no Number of Result / SERP result");
  assert.equal(attHeader.length, 5);

  const again = await api.post(`/api/baseline-jobs/${job.id}/send`).send({ to: "owner@venezia.ae", clickupTask: "86c1abcde" });
  assert.equal(again.status, 409, "sent only once");
  assert.equal(sent.length, 1);

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

test("Intent column: the AI's answer per keyword (page types sent as a hint); the rules when there's no AI", async () => {
  const { buildBaselineForRun } = await import("../backend/reporting/baselineReport.js");
  const client = await prisma.client.create({ data: { workspaceId: auth.workspace.id, name: "Intent Test", domain: "kalessie.com", kind: "domain" } });
  const run = await prisma.rankingRun.create({ data: { clientId: client.id, sourceFilename: "x.xlsx", sourceFilePath: "x", totalRows: 2, status: "COMPLETED" } });
  for (const [i, keyword] of ["zodiac jewelry", "buy anklets online"].entries()) {
    const row = await prisma.rankingRow.create({
      data: { runId: run.id, rowUid: `${run.id}-${i}`, sourceRowNumber: i + 2, keyword, targetUrl: "*kalessie.*", locationName: "United Arab Emirates", seDomain: "google.ae", languageName: "English", status: "COMPLETED", rankDisplay: "Not in 100" },
    });
    await prisma.rankingRowAttempt.create({
      data: {
        rankingRowId: row.id, attemptNumber: 1, requestPayload: {}, httpStatus: 200, dataforseoStatusCode: 20000, outcome: "SUCCESS",
        rawResponse: { tasks: [{ result: [{ items: [{ type: "organic", rank_group: 1, url: "https://www.pinterest.com/x" }, { type: "organic", rank_group: 2, url: "https://shop.ae/collections/zodiac" }] }] }] },
      },
    });
  }
  const asked: { keywords: string[]; hints: Map<string, string[]> }[] = [];
  const fakeAi = async (keywords: string[], _ctx: unknown, hints?: Map<string, string[]>) => {
    asked.push({ keywords, hints: hints ?? new Map() });
    return new Map([["zodiac jewelry", "Commercial, Transactional"]]);
  };
  const read = async (classifyIntent: typeof fakeAi | null) => {
    const built = await buildBaselineForRun({ runId: run.id, client, reportDate: new Date("2026-11-16T00:00:00Z"), classifyIntent });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.buffer as unknown as ArrayBuffer);
    const intents = new Map<string, unknown>();
    for (const r of [4, 5]) intents.set(String(wb.worksheets[0].getRow(r).getCell(1).value), wb.worksheets[0].getRow(r).getCell(6).value);
    return intents;
  };

  const withAi = await read(fakeAi);
  assert.equal(withAi.get("zodiac jewelry"), "Commercial, Transactional", "the AI answer, two intents");
  assert.equal(withAi.get("buy anklets online"), "Transactional", "no AI answer -> the rules");
  assert.deepEqual(asked[0].keywords, ["zodiac jewelry", "buy anklets online"]);
  assert.match(asked[0].hints.get("zodiac jewelry")?.[0] ?? "", /Social media/);

  // Downloading again: the remembered answer, only the unanswered keyword is asked again.
  await read(fakeAi);
  assert.deepEqual(asked[1].keywords, ["buy anklets online"]);

  const rulesOnly = await read(null);
  assert.equal(rulesOnly.get("buy anklets online"), "Transactional");

  await prisma.rankingRowAttempt.deleteMany({ where: { rankingRow: { runId: run.id } } });
  await prisma.rankingRow.deleteMany({ where: { runId: run.id } });
  await prisma.rankingRun.delete({ where: { id: run.id } });
});

test("Gemini intents for the baseline: 1 or 2 per keyword, main one first, known intents only", async () => {
  const { defaultBaselineIntentFn, formatIntents } = await import("../backend/reporting/baselineIntent.js");
  assert.equal(formatIntents(["Commercial", "Transactional", "Informational"]), "Commercial, Transactional", "never more than two");
  assert.equal(formatIntents(["transactional", "Transactional"]), "Transactional", "no repeats");
  assert.equal(formatIntents(["Purchase"]), null);
  assert.equal(defaultBaselineIntentFn({}), null, "no key -> no AI");

  let sent: { body?: string } = {};
  const fakeFetch = (async (_url: string, init: { body?: string }) => {
    sent = init;
    const answer = { results: [{ keyword: "best kitchen company dubai", intents: ["Commercial", "Transactional"] }, { keyword: "kitchen design", intents: ["Informational"] }] };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const fn = defaultBaselineIntentFn({ GEMINI_API_KEY: "test-key" }, fakeFetch)!;
  const got = await fn(["best kitchen company dubai", "kitchen design"], { clientName: "Venezia", websiteUrl: "veneziadesigns.com" }, new Map([["kitchen design", ["Google's top 10 results: 6 Blog page"]]]));
  assert.equal(got.get("best kitchen company dubai"), "Commercial, Transactional");
  assert.equal(got.get("kitchen design"), "Informational");
  const body = JSON.parse(String(sent.body));
  assert.equal(body.generationConfig.responseSchema.properties.results.items.properties.intents.maxItems, 2);
  assert.match(body.contents[0].parts[0].text, /6 Blog page/);
});
