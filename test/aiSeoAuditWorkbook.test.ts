import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildAiAuditWorkbook, type AiAuditContent } from "../backend/domainIntel/aiSeoAudit.js";

// The AI SEO Audit in the team's format (their Bricks Consultancy sample, 2026-10-23).

const content: AiAuditContent = {
  overallScore: 68,
  scanDate: "23 Oct 2026",
  verdict: "Good foundation. Key opportunities: SSL renewal, DMARC, backlinks.",
  keyMetrics: [
    { metric: "WooRank score", value: "68/100", source: "WooRank" },
    { metric: "Site Health", value: "90%", source: "Semrush" },
  ],
  keyIssues: ["SSL expires in a month.", "Backlinks are rated Bad."],
  checks: [
    { category: "On-Page (Content & Meta)", check: "Title Tag", status: "Pass", finding: "50 characters.", recommendation: "No action." },
    { category: "On-Page (Content & Meta)", check: "Meta Description", status: "Warning", finding: "167 characters.", recommendation: "Shorten to 160." },
    { category: "Indexing & Crawlability", check: "Robots.txt", status: "Pass", finding: "Found.", recommendation: "No action." },
    { category: "Mobile Usability", check: "Tap Targets", status: "Error", finding: "3 overlap.", recommendation: "Space them out." },
    { category: "Structured Data & Social Markup", check: "Twitter Card", status: "Warning", finding: "Missing twitter:site.", recommendation: "Add it." },
    { category: "Security & Performance", check: "SSL Secure", status: "Pass", finding: "Valid.", recommendation: "No action." },
    { category: "Accessibility", check: "Contrast", status: "Warning", finding: "Low contrast text.", recommendation: "Darken it." },
    { category: "Tech Stack & Branding", check: "Favicon", status: "Pass", finding: "Present.", recommendation: "No action." },
    { category: "Off-Page & Social", check: "Traffic Rank", status: "Info", finding: "Too low.", recommendation: "Re-check later." },
  ],
  technologies: [{ name: "Wix", category: "CMS" }],
  siteAudit: [{ check: "Duplicate title tags", status: "Error", finding: "2 pages.", recommendation: "Rewrite one." }],
  actionPlan: [
    { priority: "Medium", area: "Social", action: "Add twitter:site.", impact: "Better previews.", effort: "Low", owner: "Dev / SEO" },
    { priority: "High", area: "Security", action: "Renew SSL.", impact: "Avoids warnings.", effort: "Low", owner: "Dev / IT" },
  ],
};

test("AI SEO Audit workbook: the team's sheets, Dashboard counts worked out from the checks, Action Plan High first", async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildAiAuditWorkbook(content, { clientName: "Yoga Peace", websiteUrl: "https://www.yogapeaceaustralia.com", sources: ["WooRank Audit", "Semrush Site Audit"] })) as never);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["Dashboard", "On-Page SEO", "Technical SEO", "Mobile & Structured Data", "Security & Performance", "Accessibility", "Off-Page & Local", "Tech Stack & Branding", "Site Audit (Semrush)", "Action Plan"],
  );
  const dash = wb.getWorksheet("Dashboard")!;
  assert.equal(dash.getCell(1, 1).value, "Yoga Peace — SEO Audit Dashboard");
  assert.match(String(dash.getCell(2, 1).value), /Overall score: 68\/100/);
  assert.equal(dash.getCell(5, 1).value, "68");
  const row = (r: number) => (dash.getRow(r).values as unknown[]).slice(1);
  assert.deepEqual(row(9), ["Category", "Pass", "Warning / To Improve", "Error", "Informational", "Total Checks"]);
  assert.deepEqual(row(10), ["On-Page (Content & Meta)", 1, 1, 0, 0, 2]);
  assert.deepEqual(row(12), ["Mobile Usability", 0, 0, 1, 0, 1]);
  assert.deepEqual(row(17), ["Off-Page & Social", 0, 0, 0, 1, 1]);
  // Key Metrics box (added to the sample), then Key Issues.
  assert.equal(dash.getCell(20, 1).value, "Key Metrics");
  assert.deepEqual(row(22), ["WooRank score", "68/100", "WooRank"]);
  assert.equal(dash.getCell(26, 1).value, "Key Issues");
  assert.equal(dash.getCell(27, 1).value, "• SSL expires in a month.");

  // "Mobile & Structured Data" holds both of its categories; statuses are coloured, headers frozen with filters.
  const mobile = wb.getWorksheet("Mobile & Structured Data")!;
  assert.deepEqual([mobile.getCell(4, 1).value, mobile.getCell(5, 1).value], ["Tap Targets", "Twitter Card"]);
  assert.equal((mobile.getCell(4, 2).fill as { fgColor?: { argb?: string } }).fgColor?.argb, "FFFEE2E2", "Error = light red");
  assert.equal(mobile.views[0]?.state, "frozen");
  assert.ok(mobile.autoFilter);
  assert.deepEqual((wb.getWorksheet("On-Page SEO")!.getRow(3).values as unknown[]).slice(1), ["Element", "Status", "Finding", "Recommendation"]);

  const plan = wb.getWorksheet("Action Plan")!;
  assert.deepEqual([plan.getCell(4, 1).value, plan.getCell(5, 1).value], ["High", "Medium"]);
});

test("AI SEO Audit workbook: a section WooRank had no checks for gets no tab and no Dashboard row", async () => {
  // fencingcontractorssydney, 28 Oct 2026: WooRank couldn't read the homepage -- no On-Page / Mobile /
  // Structured Data / Accessibility checks at all. Those tabs used to be there, empty.
  const domainOnly = content.checks.filter((c) => ["Indexing & Crawlability", "Security & Performance", "Off-Page & Social"].includes(c.category));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildAiAuditWorkbook({ ...content, checks: domainOnly, technologies: [] }, { clientName: "Fencing", websiteUrl: "x.com.au", sources: ["WooRank Audit", "Semrush Site Audit"] })) as never);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["Dashboard", "Technical SEO", "Security & Performance", "Off-Page & Local", "Site Audit (Semrush)", "Action Plan"],
  );
  const dash = wb.getWorksheet("Dashboard")!;
  const row = (r: number) => (dash.getRow(r).values as unknown[]).slice(1);
  assert.deepEqual([10, 11, 12].map((r) => row(r)[0]), ["Indexing & Crawlability", "Security & Performance", "Off-Page & Social"]);
  assert.equal(dash.getCell(15, 1).value, "Key Metrics", "the boxes below move up");
});

test("AI SEO Audit workbook: no Semrush sheet when only WooRank was read", async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildAiAuditWorkbook({ ...content, siteAudit: [] }, { clientName: "X", websiteUrl: "x.com", sources: ["WooRank Audit"] })) as never);
  assert.equal(wb.getWorksheet("Site Audit (Semrush)"), undefined);
});
