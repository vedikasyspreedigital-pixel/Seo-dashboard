import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import { fetchGoogleAdsKeywordIdeas } from "../backend/reporting/keywordPlanner.js";
import { buildDomainReportExcel } from "../backend/domainIntel/buildDomainReportExcel.js";
import { createGooglePlannerIdeas, plannerCountryOf, type PlannerIdeasFn } from "../backend/domainIntel/plannerIdeas.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Domain Keyword Report's 4th section (2026-11-27): Google Keyword Planner's ideas for the whole site,
// service keywords only, next to Semrush / Ubersuggest / Ahrefs.

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Domain Intelligence must never call DataForSEO");
};

const ENV = {
  GOOGLE_ADS_CLIENT_ID: "id",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
  GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
} as NodeJS.ProcessEnv;

test("fetchGoogleAdsKeywordIdeas: asks for the whole site's ideas in the right country, reads volumes and competition", async () => {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response(
      JSON.stringify({
        results: [
          { text: "wedding photographer melbourne", keywordIdeaMetrics: { avgMonthlySearches: "2400", competition: "HIGH" } },
          { text: "Wedding Photographer Melbourne", keywordIdeaMetrics: { avgMonthlySearches: "2400", competition: "HIGH" } },
          { text: "photo studio hire", keywordIdeaMetrics: { competition: "UNSPECIFIED" } },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const ideas = await fetchGoogleAdsKeywordIdeas("merakiphotography.com.au", "AU", { fetchImpl, env: ENV });
  assert.deepEqual(ideas, [
    { keyword: "wedding photographer melbourne", avgMonthlySearches: 2400, competition: "HIGH" },
    { keyword: "photo studio hire", avgMonthlySearches: null, competition: null },
  ]);
  const ideasCall = calls.find((c) => c.url.includes(":generateKeywordIdeas"))!;
  assert.match(ideasCall.url, /customers\/1234567890:generateKeywordIdeas$/);
  const body = JSON.parse(ideasCall.body);
  assert.deepEqual(body.siteSeed, { site: "merakiphotography.com.au" });
  assert.deepEqual(body.geoTargetConstants, ["geoTargetConstants/2036"], "Australia");
});

test("createGooglePlannerIdeas: no ideas for pinakigroup.in -> tries www.pinakigroup.in (how Google knows that site)", async () => {
  const sites: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    const site = JSON.parse(String(init?.body)).siteSeed.site as string;
    sites.push(site);
    const results = site === "www.pinakigroup.in" ? [{ text: "serviced apartments", keywordIdeaMetrics: { avgMonthlySearches: "27100", competition: "HIGH" } }] : [];
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as unknown as typeof fetch;
  const ideas = await createGooglePlannerIdeas({ fetchImpl, env: ENV })({ websiteUrl: "https://pinakigroup.in/", location: "in" });
  assert.deepEqual(sites, ["pinakigroup.in", "www.pinakigroup.in"]);
  assert.deepEqual(ideas, [{ keyword: "serviced apartments", avgMonthlySearches: 27100, competition: "HIGH" }]);
});

test("plannerCountryOf: Domain Intelligence's locations -> Google Ads countries", () => {
  assert.equal(plannerCountryOf("au"), "AU");
  assert.equal(plannerCountryOf("uk"), "GB");
  assert.equal(plannerCountryOf("ae"), "AE");
  assert.equal(plannerCountryOf(null), "AU");
});

test("buildDomainReportExcel: the Google Keyword Planner block comes 4th with its own columns", async () => {
  const buffer = await buildDomainReportExcel([
    { source: "planner", rows: [{ keyword: "wedding photographer melbourne", volume: 2400, position: null, competition: "HIGH", intent: "Commercial" }] },
    { source: "semrush", rows: [{ keyword: "a", volume: 10, position: 3, intent: "Commercial" }] },
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Domain Keywords")!;
  assert.equal(ws.getCell(1, 1).value, "SEMrush", "tools first, Keyword Planner after them");
  assert.equal(ws.getCell(1, 6).value, "Google Keyword Planner");
  assert.deepEqual((ws.getRow(2).values as unknown[]).slice(6), ["Keyword", "Avg. Monthly Searches", "Competition", "Current position", "Intent"]);
  assert.deepEqual([6, 7, 8, 9, 10].map((c) => ws.getCell(3, c).value), ["wedding photographer melbourne", 2400, "High", null, "Commercial"]);
});

async function withReport(
  plannerIdeas: PlannerIdeasFn,
  check: (body: Record<string, any>, sheet: ExcelJS.Worksheet) => void,
  classifyWithAi: (keywords: string[]) => Promise<Map<string, "Commercial">> = async (keywords) => new Map(keywords.map((k) => [k.toLowerCase(), "Commercial" as const])),
) {
  const auth = await createAuthenticatedSession();
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async () => {},
    // Everything the rules leave open is a service keyword here (unless a test says otherwise).
    classifyWithAi,
    plannerIdeas,
  });
  const client = await prisma.client.create({ data: { name: "Meraki Photography", domain: "merakiphotography.com.au", workspaceId: auth.workspace.id } });
  const semrush = "Keyword,Position,Search Volume\nbook photographer melbourne,8,320\nphoto studio,40,90";
  try {
    const res = await authedRequest(app, auth.cookieHeader).post("/api/domain-intel/reports").field("clientId", client.id).attach("semrush", Buffer.from(semrush), "semrush.csv");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const saved = await prisma.domainReport.findUniqueOrThrow({ where: { id: res.body.id } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile((saved.files as { path: string }[])[0].path);
    check(res.body, wb.getWorksheet("Domain Keywords")!);
  } finally {
    const reports = await prisma.domainReport.findMany({ where: { clientId: client.id } });
    for (const r of reports) {
      const files = r.files as { path: string }[];
      if (files[0]) await rm(path.dirname(files[0].path), { recursive: true, force: true });
    }
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
}

test("domain report: Keyword Planner section = service ideas only, biggest first, brand left out, position from the tools", async () => {
  let asked: { websiteUrl: string; location: string | null } | null = null;
  await withReport(
    async (input) => {
      asked = input;
      return [
        { keyword: "book photographer melbourne", avgMonthlySearches: 320, competition: "MEDIUM" },
        { keyword: "how to pose for photos", avgMonthlySearches: 5000, competition: "LOW" },
        { keyword: "meraki photography", avgMonthlySearches: 480, competition: "LOW" },
        { keyword: "wedding photographer melbourne", avgMonthlySearches: 2400, competition: "HIGH" },
      ];
    },
    (body, sheet) => {
      assert.deepEqual(asked, { websiteUrl: "merakiphotography.com.au", location: null });
      assert.deepEqual(body.summary.planner, { keywords: 2, ideas: 3 }, "3 ideas after the brand one; 2 are service keywords");
      // Semrush block = columns A-D, spacer E, Keyword Planner from F.
      assert.equal(sheet.getCell(1, 6).value, "Google Keyword Planner");
      const rows = [3, 4, 5].map((r) => [6, 7, 8, 9, 10].map((c) => sheet.getCell(r, c).value));
      assert.deepEqual(rows[0], ["wedding photographer melbourne", 2400, "High", null, "Commercial"]);
      assert.deepEqual(rows[1], ["book photographer melbourne", 320, "Medium", 8, "Transactional"], "ranks 8 in Semrush; \"book\" = Transactional, still a service keyword");
      assert.deepEqual(rows[2], [null, null, null, null, null], "the informational 'how to' idea isn't a service keyword");
    },
  );
});

test("domain report: Keyword Planner failing doesn't stop the report -- the summary says why", async () => {
  await withReport(
    async () => {
      throw new Error("The Google Ads API refused the request (PERMISSION_DENIED): no access");
    },
    (body, sheet) => {
      assert.match(body.summary.planner.error, /PERMISSION_DENIED/);
      assert.equal(sheet.getCell(1, 6).value, null, "no 4th section");
      assert.equal(sheet.getCell(1, 1).value, "SEMrush");
    },
  );
});

test("domain report: the AI intent check is down -- Keyword Planner ideas stay in as 'Unclear', not dropped as Informational", async () => {
  await withReport(
    async () => [
      { keyword: "pilates reformer", avgMonthlySearches: 5400, competition: "LOW" },
      { keyword: "how to do yoga at home", avgMonthlySearches: 900, competition: "LOW" },
    ],
    (body, sheet) => {
      assert.deepEqual(body.summary.planner, { keywords: 1, ideas: 2 });
      assert.deepEqual([6, 7, 10].map((c) => sheet.getCell(3, c).value), ["pilates reformer", 5400, "Unclear"]);
      assert.equal(sheet.getCell(4, 6).value, null, "the 'how to' idea is still left out (the rules know it's informational)");
    },
    async () => {
      throw new Error("Gemini 403: free tier not available");
    },
  );
});
