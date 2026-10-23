import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import { readKeywordExport } from "../backend/domainIntel/readKeywordExport.js";
import { competitorSheetRows, GAP_ROWS_PER_COMPETITOR } from "../backend/domainIntel/buildDomainReportExcel.js";
import { clearCompetitorSearches, parseCompetitorsCsv } from "../backend/domainIntel/competitorJob.js";
import { clearFetchJobs } from "../backend/domainIntel/fetchJob.js";
import type { FetchExportFn } from "../backend/domainIntel/fetchers/flikoverAhrefs.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Keyword Analysis with competitors (team's decision, 2026-10-23): the client's
// Semrush keywords and 3 competitors' side by side -- position, landing page,
// traffic per site; volume, difficulty, intent once per keyword -- plus each
// competitor's best keywords the client doesn't rank for.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Domain Intelligence must never call DataForSEO");
};

// Semrush Positions export columns, as in the real file (incl. the look-alike "Traffic (%)" / "Traffic Cost").
const HEADER = '"Keyword","Position","Previous position","Search Volume","Keyword Difficulty","CPC","URL","Traffic","Traffic (%)","Traffic Cost","Keyword Intents"';
const semrushCsv = (site: string, rows: [string, number, number, number, number][]) =>
  [HEADER, ...rows.map(([k, pos, vol, kd, traffic]) => `"${k}","${pos}","${pos}","${vol}","${kd}","1.0","https://${site}/${k.replace(/ /g, "-")}","${traffic}","1.5","99","commercial"`)].join("\n");

test("readKeywordExport: Semrush URL, Traffic and Keyword Difficulty (never Traffic (%) or Traffic Cost)", async () => {
  const e = await readKeywordExport("semrush", Buffer.from(semrushCsv("a.com", [["yoga near me", 2, 9900, 38, 1306]])), "a.csv");
  assert.deepEqual(
    { url: e.rows[0].url, traffic: e.rows[0].traffic, difficulty: e.rows[0].difficulty },
    { url: "https://a.com/yoga-near-me", traffic: 1306, difficulty: 38 },
  );
});

test("parseCompetitorsCsv: Semrush's order kept, the client itself and duplicates dropped, 1.2K read as 1200", () => {
  const csv = ["Domain,Com. Level rank,Com. Keywords,SE Keywords", "www.yogapeaceaustralia.com,1,999,999", "unpluggedyoga.com.au,2,52,1.2K", "meltonyoga.com.au,3,43,74", "Meltonyoga.com.au,4,1,1", "not a domain,5,1,1"].join("\n");
  assert.deepEqual(parseCompetitorsCsv(csv, "https://www.yogapeaceaustralia.com"), [
    { domain: "unpluggedyoga.com.au", commonKeywords: 52, totalKeywords: 1200 },
    { domain: "meltonyoga.com.au", commonKeywords: 43, totalKeywords: 74 },
  ]);
});

test("competitorSheetRows: client keywords first (by position), then competitors' gaps by traffic, each keyword once", () => {
  const row = (keyword: string, position: number, traffic: number, url = `https://x/${keyword}`) => ({ keyword, position, volume: 100, traffic, difficulty: 30, url });
  const rows = competitorSheetRows({
    client: { domain: "client.com", rows: [row("b", 7, 5), row("a", 2, 50)] },
    competitors: [
      { domain: "c1.com", rows: [row("a", 1, 80), row("gap small", 9, 3), row("gap big", 3, 400)] },
      { domain: "c2.com", rows: [row("gap big", 5, 100), row("gap mid", 4, 60)] },
    ],
    intentOf: () => "Commercial",
  });
  assert.deepEqual(
    rows.map((r) => [r.keyword, r.status, r.sites.map((s) => s?.position ?? null)]),
    [
      ["a", "Client ranks", [2, 1, null]],
      ["b", "Client ranks", [7, null, null]],
      ["gap big", "Gap -- competitors only", [null, 3, 5]],
      ["gap mid", "Gap -- competitors only", [null, null, 4]],
      ["gap small", "Gap -- competitors only", [null, 9, null]],
    ],
  );
  assert.equal(rows[0].sites[1]?.url, "https://x/a");
  assert.equal(GAP_ROWS_PER_COMPETITOR, 200);
});

test("competitorSheetRows: a competitor's own brand searches are not gaps (seen 2026-10-23: 'unplugged yoga', 'yoga bayside' topped the list)", () => {
  const row = (keyword: string, traffic: number) => ({ keyword, position: 1, volume: 100, traffic, difficulty: 20, url: "https://x/" });
  const rows = competitorSheetRows({
    client: { domain: "yogapeaceaustralia.com", rows: [row("yoga parramatta", 50)] },
    competitors: [
      { domain: "unpluggedyoga.com.au", rows: [row("unplugged yoga", 472), row("hot yoga sydney", 90)] },
      { domain: "yogabayside.com.au", rows: [row("yoga bayside brisbane", 88), row("bayside yoga", 56), row("yin yoga", 40)] },
    ],
    intentOf: () => "Commercial",
  });
  assert.deepEqual(
    rows.map((r) => r.keyword),
    ["yoga parramatta", "hot yoga sydney", "yin yoga"],
  );
});

test("Find competitors -> fetch them -> Combine: the report gets a side-by-side Competitors sheet", async () => {
  clearFetchJobs();
  clearCompetitorSearches();
  const auth = await createAuthenticatedSession();
  const competitorList = ["Domain,Com. Level rank,Com. Keywords,SE Keywords", "c1.com.au,1,52,206", "c2.com.au,2,43,74", "c3.com.au,3,33,370", "c4.com.au,4,29,128"].join("\n");
  const competitorFetcher: FetchExportFn = async () => ({ buffer: Buffer.from(competitorList), fileName: "competitors.csv" });
  const pages: Record<string, [string, number, number, number, number][]> = {
    "yogapeace.com.au": [["yoga parramatta", 1, 500, 20, 300]],
    "c1.com.au": [["yoga parramatta", 4, 500, 20, 40], ["hot yoga sydney", 2, 900, 35, 250]],
    "c2.com.au": [["hot yoga sydney", 6, 900, 35, 30]],
    "c3.com.au": [["yin yoga", 3, 300, 15, 70]],
  };
  const semrush: FetchExportFn = async ({ domain }) => ({ buffer: Buffer.from(semrushCsv(domain, pages[domain] ?? [])), fileName: `${domain}-semrush.csv` });
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async () => {},
    classifyWithAi: null,
    fetchers: { semrush },
    competitorFetcher,
  });
  const client = await prisma.client.create({ data: { name: "Yoga Peace", domain: "https://yogapeace.com.au", workspaceId: auth.workspace.id } });
  const api = authedRequest(app, auth.cookieHeader);
  const poll = async (url: string, done: (b: { state: string }) => boolean) => {
    let body = (await api.get(url)).body;
    for (let i = 0; i < 100 && !done(body); i++) {
      await new Promise((r) => setTimeout(r, 20));
      body = (await api.get(url)).body;
    }
    return body;
  };
  try {
    const search = await api.post("/api/domain-intel/competitors").send({ clientId: client.id, location: "au" });
    assert.equal(search.status, 202, JSON.stringify(search.body));
    const found = await poll(`/api/domain-intel/competitors/${search.body.id}`, (b) => b.state === "done" || b.state === "failed");
    assert.equal(found.state, "done", JSON.stringify(found));
    assert.deepEqual(found.competitors.slice(0, 3).map((c: { domain: string }) => c.domain), ["c1.com.au", "c2.com.au", "c3.com.au"]);

    // The client's own Semrush fetch and 3 competitors' run side by side (not merged into one job).
    const fetchIds: string[] = [];
    for (const site of ["yogapeace.com.au", "c1.com.au", "c2.com.au", "c3.com.au"]) {
      const f = await api.post("/api/domain-intel/fetches").send({ source: "semrush", clientId: client.id, websiteUrl: site, location: "au" });
      assert.equal(f.status, 202, JSON.stringify(f.body));
      fetchIds.push(f.body.id);
    }
    assert.equal(new Set(fetchIds).size, 4);
    for (const id of fetchIds) assert.equal((await poll(`/api/domain-intel/fetches/${id}`, (b) => b.state === "done" || b.state === "failed")).state, "done");

    const tooMany = await api.post("/api/domain-intel/reports").field("clientId", client.id).field("fetched_semrush", fetchIds[0]).field("competitor_fetches", fetchIds.join(","));
    assert.equal(tooMany.status, 400);

    const res = await api
      .post("/api/domain-intel/reports")
      .field("clientId", client.id)
      .field("fetched_semrush", fetchIds[0])
      .field("competitor_fetches", fetchIds.slice(1).join(","));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.summary.competitors, [
      { domain: "c1.com.au", keywords: 2 },
      { domain: "c2.com.au", keywords: 1 },
      { domain: "c3.com.au", keywords: 1 },
    ]);

    const saved = await prisma.domainReport.findUniqueOrThrow({ where: { id: res.body.id } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile((saved.files as { path: string }[])[0].path);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Domain Keywords", "Competitors"]);
    const sheet = wb.getWorksheet("Competitors")!;
    const rowValues = (r: number) => (sheet.getRow(r).values as unknown[]).slice(1);
    assert.deepEqual(rowValues(1).filter((v, i, a) => v && a.indexOf(v) === i), ["Keyword", "yogapeace.com.au (client)", "c1.com.au", "c2.com.au", "c3.com.au"]);
    assert.deepEqual(rowValues(2).slice(0, 7), ["Keyword", "Search Volume", "Keyword Difficulty", "Intent", "Position", "Landing page URL", "Traffic"], "no Status column");
    // Client keyword (with c1 beside it), then gaps by competitor traffic -- blank client columns mark a gap.
    assert.deepEqual(
      [3, 4, 5].map((r) => [rowValues(r)[0], rowValues(r)[4], rowValues(r)[7]]),
      [
        ["yoga parramatta", 1, 4],
        ["hot yoga sydney", undefined, 2],
        ["yin yoga", undefined, undefined],
      ],
    );
    assert.equal(rowValues(3)[5], "https://yogapeace.com.au/yoga-parramatta");
    assert.equal(rowValues(3)[2], 20, "keyword difficulty");

    // Competitors without the client's own Semrush data can't be compared.
    const noClient = await api.post("/api/domain-intel/reports").field("clientId", client.id).attach("ahrefs", Buffer.from("Keyword,Volume,Current position\nx,1,1"), "a.csv").field("competitor_fetches", fetchIds[1]);
    assert.equal(noClient.status, 422);
    assert.match(noClient.body.error, /client's Semrush export/);
  } finally {
    const reports = await prisma.domainReport.findMany({ where: { clientId: client.id } });
    for (const r of reports) {
      const files = r.files as { path: string }[];
      if (files[0]) await rm(path.dirname(files[0].path), { recursive: true, force: true });
    }
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
    clearFetchJobs();
    clearCompetitorSearches();
  }
});
