import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildGapWorkbook, findGaps, keepRealOpportunities, siteOverview, type GapAdvice } from "../backend/domainIntel/gapReport.js";

// Gap & Competitor Analysis (team's decision, 2026-10-23): gaps, missed opportunities and actions.

const row = (keyword: string, position: number | null, volume: number, difficulty: number, traffic = 10) => ({
  keyword,
  position,
  volume,
  difficulty,
  traffic,
  url: `https://site/${keyword.replace(/ /g, "-")}`,
});

const client = { domain: "yogapeaceaustralia.com", rows: [row("yoga parramatta", 1, 500, 20, 300), row("hot yoga sydney", 15, 900, 35, 5), row("yin yoga", 4, 300, 15, 40)] };
const competitors = [
  { domain: "unpluggedyoga.com.au", rows: [row("hot yoga sydney", 2, 900, 35, 250), row("unplugged yoga", 1, 590, 22), row("yoga for beginners", 8, 1200, 28, 60), row("yoga retreat", 45, 2000, 50)] },
  { domain: "yogabayside.com.au", rows: [row("yoga for beginners", 5, 1200, 28, 90), row("yin yoga", 9, 300, 15), row("prenatal yoga", 12, 400, 18)] },
];

test("findGaps: Missing (competitor top 20, client absent) and Weak (client 11+ and behind); brands, client-wins and 21+ left out", () => {
  const gaps = findGaps(client, competitors, () => "Commercial");
  assert.deepEqual(
    gaps.map((g) => [g.keyword, g.type, g.bestCompetitor, g.bestPosition, g.clientPosition, g.competitorsRanking]),
    [
      ["yoga for beginners", "Missing", "yogabayside.com.au", 5, null, 2],
      ["hot yoga sydney", "Weak", "unpluggedyoga.com.au", 2, 15, 1],
      ["prenatal yoga", "Missing", "yogabayside.com.au", 12, null, 1],
    ],
  );
  assert.equal(gaps[0].competitorUrl, "https://site/yoga-for-beginners");
});

test("findGaps: searches for other businesses (Navigational) aren't gaps", () => {
  const gaps = findGaps(client, competitors, (k) => (k === "prenatal yoga" ? "Navigational" : "Commercial"));
  assert.deepEqual(
    gaps.map((g) => g.keyword),
    ["yoga for beginners", "hot yoga sydney"],
  );
});

test("siteOverview: ranking keywords, top 3, top 10 and summed traffic", () => {
  assert.deepEqual(siteOverview(client), { domain: "yogapeaceaustralia.com", keywords: 3, top3: 1, top10: 2, traffic: 345 });
});

test("buildGapWorkbook: Summary + Keyword Gaps always; Missed Opportunities + Action Plan only with Gemini's advice", async () => {
  const overview = [client, ...competitors].map(siteOverview);
  const gaps = findGaps(client, competitors);
  const load = async (advice: GapAdvice | null) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildGapWorkbook({ clientName: "Yoga Peace", websiteUrl: "yogapeaceaustralia.com", dateLabel: "23rd October 2026", overview, gaps, advice, adviceNote: "Gemini busy" })) as never);
    return wb;
  };

  const plain = await load(null);
  assert.deepEqual(plain.worksheets.map((w) => w.name), ["Summary", "Keyword Gaps"]);
  const summary = plain.getWorksheet("Summary")!;
  assert.deepEqual((summary.getRow(5).values as unknown[]).slice(1), ["yogapeaceaustralia.com (client)", 3, 1, 2, 345]);
  assert.deepEqual((summary.getRow(10).values as unknown[]).slice(1), ["Missing — competitors rank top 20, client doesn't", 2]);
  assert.equal(summary.getCell(15, 1).value, "Gemini busy");
  assert.equal(plain.getWorksheet("Keyword Gaps")!.getCell(4, 1).value, "yoga for beginners");

  const advised = await load({
    summary: "Yoga Peace leads locally.",
    keyFindings: ["Bayside wins beginner content."],
    opportunities: [
      { priority: "Medium", keyword: "prenatal yoga", recommendation: "Add a prenatal class page.", targetPage: "New page: Prenatal Yoga" },
      { priority: "High", keyword: "yoga for beginners", recommendation: "Build a beginners guide.", targetPage: "New page: Yoga for Beginners" },
    ],
    actionPlan: [{ priority: "High", area: "Content", action: "Create beginner hub.", impact: "Captures 1,200 searches.", effort: "Medium", owner: "SEO / Content" }],
  });
  assert.deepEqual(advised.worksheets.map((w) => w.name), ["Summary", "Keyword Gaps", "Missed Opportunities", "Action Plan"]);
  const opps = advised.getWorksheet("Missed Opportunities")!;
  assert.deepEqual((opps.getRow(4).values as unknown[]).slice(1, 6), ["High", "yoga for beginners", 1200, 28, "Missing"], "High first, numbers from the gap data");
});

// Audit 2026-10-27: a keyword Gemini made up (not in the gap list) went into Missed Opportunities with blank numbers.
test("keepRealOpportunities: only keywords that are real gaps stay (matched ignoring case/spacing)", () => {
  const gaps = findGaps(client, competitors);
  const advice: GapAdvice = {
    summary: "s",
    keyFindings: [],
    opportunities: [
      { priority: "High", keyword: "Yoga  for Beginners", recommendation: "r", targetPage: "p" },
      { priority: "Low", keyword: "aerial yoga melbourne", recommendation: "made up", targetPage: "p" },
    ],
    actionPlan: [],
  };
  assert.deepEqual(keepRealOpportunities(advice, gaps).opportunities.map((o) => o.keyword), ["Yoga  for Beginners"]);
});