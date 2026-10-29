import ExcelJS from "exceljs";
import { z } from "zod";

// Domain Intelligence report 5, the AI SEO Audit, in the team's own format
// (their Bricks Consultancy sample, 2026-10-23): an Excel workbook built from
// the WooRank scan -- a Dashboard (score, category counts, key issues), one
// sheet per area with Check / Status / Finding / Recommendation, the tech
// stack, and a prioritised Action Plan. Gemini reads the reports' PDFs and
// fills in the checks; the counts on the Dashboard are worked out here from
// those checks, so they always add up. When the Semrush Site Audit is there
// too, its site-wide findings get their own sheet and feed the Action Plan.

export interface AuditSource {
  /** e.g. "WooRank Audit", "Semrush Site Audit" */
  label: string;
  fileName: string;
  buffer: Buffer;
}

export type AiAuditWriter = (input: {
  clientName: string;
  websiteUrl: string;
  sources: AuditSource[];
  onStep: (step: string) => void;
}) => Promise<{ buffer: Buffer; fileName: string }>;

/** The Dashboard's categories, in the sample's order. */
export const CATEGORIES = [
  "On-Page (Content & Meta)",
  "Indexing & Crawlability",
  "Mobile Usability",
  "Structured Data & Social Markup",
  "Security & Performance",
  "Accessibility",
  "Tech Stack & Branding",
  "Off-Page & Social",
] as const;
type Category = (typeof CATEGORIES)[number];

const STATUSES = ["Pass", "Warning", "Error", "Info"] as const;
const PRIORITIES = ["High", "Medium", "Low"] as const;
const EFFORTS = ["Low", "Medium", "High"] as const;

const Check = z.object({
  category: z.enum(CATEGORIES),
  check: z.string(),
  status: z.enum(STATUSES),
  finding: z.string(),
  recommendation: z.string(),
});
const AuditContent = z.object({
  overallScore: z.number().nullable(),
  scanDate: z.string(),
  verdict: z.string(),
  /** Headline numbers from the reports, e.g. Semrush Site Health 90% -- for the Dashboard's Key Metrics box. */
  keyMetrics: z.array(z.object({ metric: z.string(), value: z.string(), source: z.string() })),
  keyIssues: z.array(z.string()),
  checks: z.array(Check),
  technologies: z.array(z.object({ name: z.string(), category: z.string() })),
  siteAudit: z.array(Check.omit({ category: true })),
  actionPlan: z.array(
    z.object({
      priority: z.enum(PRIORITIES),
      area: z.string(),
      action: z.string(),
      impact: z.string(),
      effort: z.enum(EFFORTS),
      owner: z.string(),
    }),
  ),
});
export type AiAuditContent = z.infer<typeof AuditContent>;

const CHECK_PROPS = {
  check: { type: "STRING" },
  status: { type: "STRING", enum: [...STATUSES] },
  finding: { type: "STRING" },
  recommendation: { type: "STRING" },
};
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    overallScore: { type: "NUMBER", nullable: true },
    scanDate: { type: "STRING" },
    verdict: { type: "STRING" },
    keyMetrics: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { metric: { type: "STRING" }, value: { type: "STRING" }, source: { type: "STRING" } }, required: ["metric", "value", "source"] },
    },
    keyIssues: { type: "ARRAY", items: { type: "STRING" } },
    checks: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { category: { type: "STRING", enum: [...CATEGORIES] }, ...CHECK_PROPS }, required: ["category", "check", "status", "finding", "recommendation"] },
    },
    technologies: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, category: { type: "STRING" } }, required: ["name", "category"] } },
    siteAudit: { type: "ARRAY", items: { type: "OBJECT", properties: CHECK_PROPS, required: ["check", "status", "finding", "recommendation"] } },
    actionPlan: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          priority: { type: "STRING", enum: [...PRIORITIES] },
          area: { type: "STRING" },
          action: { type: "STRING" },
          impact: { type: "STRING" },
          effort: { type: "STRING", enum: [...EFFORTS] },
          owner: { type: "STRING" },
        },
        required: ["priority", "area", "action", "impact", "effort", "owner"],
      },
    },
  },
  required: ["overallScore", "scanDate", "verdict", "keyMetrics", "keyIssues", "checks", "technologies", "siteAudit", "actionPlan"],
};

const SYSTEM_PROMPT = `You are a senior SEO consultant at SySpree Digital turning SEO tool reports into the agency's SEO audit workbook.
Use ONLY facts in the attached reports -- never invent numbers, pages or issues. Short, factual findings; practical recommendations.

From the WooRank report:
- overallScore: its overall score (number), scanDate: the date it shows (e.g. "23 Oct 2026").
- checks: one row for EVERY check WooRank lists, in its order, each in exactly one category:
  "On-Page (Content & Meta)" (title, meta description, Google preview, headings, content analysis, alt attributes, in-page links, language),
  "Indexing & Crawlability" (web feeds, URL resolve, robots.txt, XML sitemap, sitemap validity, URL parameters, canonical, robots tags, index and follow, hreflang, broken links, underscores, discovered pages),
  "Mobile Usability" (mobile friendliness, mobile rendering, tap targets, plugins, font size, viewport, mobile frameworks, AMP),
  "Structured Data & Social Markup" (schema.org, Open Graph, Twitter Card, microformats),
  "Security & Performance" (email privacy, DMARC, SSL, mixed content, asset minification/compression/cacheability, image optimization, layout shift, LCP),
  "Accessibility" (contrast, navigation),
  "Tech Stack & Branding" (analytics, doctype, encoding, server IP, URL, favicon, custom 404, domain registration, domain/typo availability),
  "Off-Page & Social" (backlinks score/counter, referring domains, traffic estimations, traffic rank, local directories, online reviews, social profiles, social accounts, social engagement).
  status: Pass (green tick), Warning (to improve), Error (red), Info (informational). finding: what WooRank found, with its figures.
  recommendation: the concrete next step ("No action." when nothing is needed).
- technologies: every detected technology with a short category (Server, CMS, Analytics, Frontend, Social, ...).
- verdict: one line, e.g. "Good foundation. Key opportunities: ...".
- keyMetrics: 6-10 headline numbers exactly as the reports show them, each with its source ("WooRank" / "Semrush"):
  WooRank score, backlinks, referring domains, traffic estimation, Google reviews; Semrush Site Health, AI Search Health,
  crawled pages, errors, warnings (only those present).
- keyIssues: 6-10 short bullets of the most important problems (no bullet symbol).

From the Semrush Site Audit (when attached): siteAudit = its site-wide issues (errors, then warnings, then notable notices) as
check / status / finding (with page counts) / recommendation; otherwise an empty list.

actionPlan: 8-14 prioritised actions across all reports (High first), each with area, action, expected impact, effort (Low/Medium/High)
and owner (e.g. "SEO / Content", "Dev / SEO", "Dev / IT", "Marketing / SEO", "Admin / IT").`;

const GEMINI_TIMEOUT_MS = 240_000;
const FALLBACK_MODEL = "gemini-flash-lite-latest";

export function createGeminiAuditWriter(apiKey: string, model = process.env.GEMINI_AUDIT_MODEL || "gemini-flash-latest"): AiAuditWriter {
  return async ({ clientName, websiteUrl, sources, onStep }) => {
    onStep(`Gemini is reading ${sources.map((s) => s.label).join(", ")}`);
    const content = await askGemini(apiKey, model, clientName, websiteUrl, sources);
    onStep("Writing the AI SEO Audit workbook");
    const buffer = await buildAiAuditWorkbook(content, { clientName, websiteUrl, sources: sources.map((s) => s.label) });
    return { buffer, fileName: `${hostOf(websiteUrl)}-ai-seo-audit.xlsx` };
  };
}

async function askGemini(apiKey: string, model: string, clientName: string, websiteUrl: string, sources: AuditSource[]): Promise<AiAuditContent> {
  const parts = [
    { text: `Client: ${clientName} (${websiteUrl})\nReports attached: ${sources.map((s) => s.label).join(", ")}` },
    ...sources.flatMap((s) => [{ text: `--- ${s.label} (${s.fileName}) ---` }, { inlineData: { mimeType: "application/pdf", data: s.buffer.toString("base64") } }]),
  ];
  const parsed = AuditContent.safeParse(await geminiJson(apiKey, model, SYSTEM_PROMPT, parts, RESPONSE_SCHEMA, "the AI SEO Audit"));
  if (!parsed.success) throw new Error("Gemini's answer wasn't a complete audit -- try again.");
  return parsed.data;
}

/**
 * One Gemini call with a JSON response schema -> the parsed answer (null if it wasn't JSON). "High demand"
 * (503) and rate limits (429) are usually brief: retried, and finally tried on the lighter model.
 */
export async function geminiJson(apiKey: string, model: string, systemPrompt: string, parts: unknown[], schema: object, what: string): Promise<unknown> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: schema },
  });
  const attempts = [model, model, model, FALLBACK_MODEL];
  let res: Response | null = null;
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, i * 5000));
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(attempts[i])}:generateContent`, {
        method: "POST",
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
      });
    } catch (err) {
      // Too slow (seen 2026-10-26: "The operation was aborted due to timeout"): don't wait that long
      // again on the same model -- go straight to the lighter, faster one.
      const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
      if (!timedOut) throw err;
      console.error(`[domainIntel] ${what}: Gemini (${attempts[i]}) took longer than ${GEMINI_TIMEOUT_MS / 1000}s`);
      if (i >= attempts.length - 1) throw new Error(`Gemini took too long -- try ${what} again in a few minutes.`);
      i = attempts.length - 2; // the loop's i++ lands on the fallback model
      continue;
    }
    if (res.ok || (res.status !== 503 && res.status !== 429 && res.status !== 500)) break;
  }
  if (!res!.ok) {
    const busy = res!.status === 503 || res!.status === 429;
    console.error(`[domainIntel] ${what}: Gemini ${res!.status}: ${(await res!.text()).slice(0, 300)}`);
    throw new Error(busy ? `Gemini is busy right now (high demand) -- try ${what} again in a few minutes.` : `Gemini refused the request (${res!.status}).`);
  }
  const answer = (await res!.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return safeJson(answer.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();

// ---- the workbook (layout and colours from the team's sample) ----

const DARK = "FF1F2937";
const BLUE = "FF2563EB";
const SCORE_FILL = "FFFFF7E6";
const GREEN_HEADER = "FF003300";
export const PRIORITY_FILL: Record<string, string> = { High: "FFFEE2E2", Medium: "FFFEF3C7", Low: "FFDCFCE7" };
const STATUS_FONT: Record<string, string> = { Pass: "FF15803D", Warning: "FFB45309", Error: "FFB91C1C", Info: "FF4B5563" };
// Light status fills so problems stand out at a glance (an addition to the sample, the user's go-ahead 2026-10-23).
const STATUS_FILL: Record<string, string> = { Pass: "FFDCFCE7", Warning: "FFFEF3C7", Error: "FFFEE2E2", Info: "FFF3F4F6" };

function styleStatus(cell: ExcelJS.Cell, status: string) {
  cell.font = { bold: true, color: { argb: STATUS_FONT[status] ?? "FF111827" } };
  if (STATUS_FILL[status]) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_FILL[status] } };
  cell.alignment = { horizontal: "center", vertical: "top" };
}

/** Header row frozen, filter buttons on it, landscape A4 fitted to the page width. */
export function finishSheet(sheet: ExcelJS.Worksheet, headerRowNo: number, lastCol: number, lastRow: number) {
  sheet.views = [{ state: "frozen", ySplit: headerRowNo }];
  if (lastRow > headerRowNo) sheet.autoFilter = { from: { row: headerRowNo, column: 1 }, to: { row: lastRow, column: lastCol } };
  sheet.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

/** Sheets of checks: name, title, first-column header, categories. */
const CHECK_SHEETS: { name: string; title: string; first: string; categories: Category[]; widths: number[] }[] = [
  { name: "On-Page SEO", title: "On-Page SEO — Content & Meta Elements", first: "Element", categories: ["On-Page (Content & Meta)"], widths: [28, 20, 65, 65] },
  { name: "Technical SEO", title: "Technical SEO — Indexing, Crawlability & Site Health", first: "Check", categories: ["Indexing & Crawlability"], widths: [28, 20, 65, 65] },
  {
    name: "Mobile & Structured Data",
    title: "Mobile Usability & Structured Data",
    first: "Check",
    categories: ["Mobile Usability", "Structured Data & Social Markup"],
    widths: [30, 20, 65, 65],
  },
  { name: "Security & Performance", title: "Security & Performance", first: "Check", categories: ["Security & Performance"], widths: [30, 20, 65, 65] },
  { name: "Accessibility", title: "Accessibility — UX & WCAG-related Checks", first: "Check", categories: ["Accessibility"], widths: [32, 20, 65, 65] },
  { name: "Off-Page & Local", title: "Off-Page SEO — Backlinks, Traffic & Social", first: "Area", categories: ["Off-Page & Social"], widths: [30, 20, 65, 65] },
];

export function titleRow(sheet: ExcelJS.Worksheet, text: string, lastCol: number) {
  sheet.mergeCells(1, 1, 1, lastCol);
  const cell = sheet.getCell(1, 1);
  cell.value = text;
  cell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK } };
  cell.alignment = { vertical: "middle" };
  sheet.getRow(1).height = 26;
}

export function headerRow(sheet: ExcelJS.Worksheet, row: number, labels: string[], fill = BLUE) {
  labels.forEach((label, i) => {
    const cell = sheet.getCell(row, i + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
}

function checkRows(sheet: ExcelJS.Worksheet, startRow: number, rows: { check: string; status: string; finding: string; recommendation: string }[]) {
  rows.forEach((r, i) => {
    const row = sheet.getRow(startRow + i);
    row.values = [r.check, r.status, r.finding, r.recommendation];
    row.alignment = { vertical: "top", wrapText: true };
    styleStatus(row.getCell(2), r.status);
  });
  return startRow + rows.length - 1;
}

function addTechSheet(wb: ExcelJS.Workbook, technologies: AiAuditContent["technologies"], brandChecks: AiAuditContent["checks"]) {
  const tech = wb.addWorksheet("Tech Stack & Branding");
  [24, 57, 70].forEach((w, i) => (tech.getColumn(i + 1).width = w));
  titleRow(tech, "Technology Stack & Branding Reference", 3);
  tech.mergeCells(3, 1, 3, 2);
  tech.getCell(3, 1).value = "Detected Technologies";
  tech.getCell(3, 1).font = { bold: true };
  headerRow(tech, 4, ["Technology", "Category"]);
  technologies.forEach((t, i) => (tech.getRow(5 + i).values = [t.name, t.category]));
  const brandRow = 5 + technologies.length + 3;
  headerRow(tech, brandRow, ["Technology & Branding Checks", "Status", "Finding"], GREEN_HEADER);
  brandChecks.forEach((c, i) => {
    const row = tech.getRow(brandRow + 1 + i);
    row.values = [c.check, c.status, c.finding];
    row.alignment = { vertical: "top", wrapText: true };
    styleStatus(row.getCell(2), c.status);
  });
  tech.views = [{ state: "frozen", ySplit: 1 }];
  tech.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

export async function buildAiAuditWorkbook(content: AiAuditContent, meta: { clientName: string; websiteUrl: string; sources: string[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const score = content.overallScore ?? null;

  // Dashboard
  const dash = wb.addWorksheet("Dashboard");
  [42, 12, 18, 10, 16, 14].forEach((w, i) => (dash.getColumn(i + 1).width = w));
  titleRow(dash, `${meta.clientName} — SEO Audit Dashboard`, 5);
  dash.mergeCells(2, 1, 2, 5);
  dash.getCell(2, 1).value = `Source: ${meta.sources.join(" + ")} scan, ${content.scanDate} | Website: ${meta.websiteUrl}${score !== null ? ` | Overall score: ${score}/100` : ""}`;
  dash.getCell(2, 1).font = { italic: true, color: { argb: "FF4B5563" } };
  dash.getCell(4, 1).value = "Overall SEO Health Score";
  dash.getCell(4, 1).font = { bold: true };
  const scoreCell = dash.getCell(5, 1);
  scoreCell.value = score !== null ? String(score) : "—";
  scoreCell.font = { bold: true, size: 20 };
  scoreCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SCORE_FILL } };
  scoreCell.alignment = { horizontal: "center", vertical: "middle" };
  dash.mergeCells(5, 2, 5, 5);
  dash.getCell(5, 2).value = content.verdict;
  dash.getCell(5, 2).alignment = { wrapText: true, vertical: "middle" };
  dash.getRow(5).height = 44;
  headerRow(dash, 9, ["Category", "Pass", "Warning / To Improve", "Error", "Informational", "Total Checks"]);
  // Only categories the reports actually checked (the team's call, 2026-10-29): when WooRank couldn't read a
  // site's homepage it has no On-Page / Mobile / Accessibility checks, and empty rows and tabs looked broken.
  const checked = CATEGORIES.filter((cat) => content.checks.some((c) => c.category === cat));
  checked.forEach((cat, i) => {
    const inCat = content.checks.filter((c) => c.category === cat);
    const n = (s: string) => inCat.filter((c) => c.status === s).length;
    dash.getRow(10 + i).values = [cat, n("Pass"), n("Warning"), n("Error"), n("Info"), inCat.length];
  });
  // Key Metrics: the reports' headline numbers side by side (an addition to the sample).
  let r0 = 10 + checked.length + 2;
  if (content.keyMetrics.length > 0) {
    dash.getCell(r0, 1).value = "Key Metrics";
    dash.getCell(r0, 1).font = { bold: true };
    headerRow(dash, r0 + 1, ["Metric", "Value", "Source"]);
    content.keyMetrics.forEach((m, i) => {
      const row = dash.getRow(r0 + 2 + i);
      row.values = [m.metric, m.value, m.source];
      row.getCell(2).font = { bold: true };
    });
    r0 += 2 + content.keyMetrics.length + 2;
  }
  const issuesRow = r0;
  dash.getCell(issuesRow, 1).value = "Key Issues";
  dash.getCell(issuesRow, 1).font = { bold: true };
  content.keyIssues.forEach((issue, i) => {
    const r = issuesRow + 1 + i;
    dash.mergeCells(r, 1, r, 6);
    dash.getCell(r, 1).value = `• ${issue}`;
    dash.getCell(r, 1).alignment = { wrapText: true, vertical: "top" };
  });
  dash.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // One sheet per area -- left out when it has no checks at all.
  for (const s of CHECK_SHEETS) {
    const rows = content.checks.filter((c) => s.categories.includes(c.category));
    if (rows.length === 0) continue;
    const sheet = wb.addWorksheet(s.name);
    s.widths.forEach((w, i) => (sheet.getColumn(i + 1).width = w));
    titleRow(sheet, s.title, 4);
    headerRow(sheet, 3, [s.first, "Status", "Finding", "Recommendation"]);
    finishSheet(sheet, 3, 4, checkRows(sheet, 4, rows));
  }

  // Tech stack & branding -- also only when there's something in it.
  const brandChecks = content.checks.filter((c) => c.category === "Tech Stack & Branding");
  if (content.technologies.length > 0 || brandChecks.length > 0) addTechSheet(wb, content.technologies, brandChecks);

  // Semrush's site-wide crawl, when it was part of the audit
  if (content.siteAudit.length > 0) {
    const sa = wb.addWorksheet("Site Audit (Semrush)");
    [34, 20, 65, 65].forEach((w, i) => (sa.getColumn(i + 1).width = w));
    titleRow(sa, "Site-wide Crawl — Semrush Site Audit", 4);
    headerRow(sa, 3, ["Issue", "Status", "Finding", "Recommendation"]);
    finishSheet(sa, 3, 4, checkRows(sa, 4, content.siteAudit));
  }

  // Action plan
  const plan = wb.addWorksheet("Action Plan");
  [10, 20, 62, 58, 12, 18].forEach((w, i) => (plan.getColumn(i + 1).width = w));
  titleRow(plan, "Prioritized Action Plan", 6);
  headerRow(plan, 3, ["Priority", "Area", "Action Item", "Expected Impact", "Effort", "Owner"]);
  const order = { High: 0, Medium: 1, Low: 2 };
  [...content.actionPlan]
    .sort((a, b) => order[a.priority] - order[b.priority])
    .forEach((a, i) => {
      const row = plan.getRow(4 + i);
      row.values = [a.priority, a.area, a.action, a.impact, a.effort, a.owner];
      row.alignment = { vertical: "top", wrapText: true };
      row.getCell(1).font = { bold: true };
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: PRIORITY_FILL[a.priority] } };
    });
  finishSheet(plan, 3, 6, 3 + content.actionPlan.length);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
