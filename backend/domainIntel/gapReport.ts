import ExcelJS from "exceljs";
import { z } from "zod";
import { brandTerms, matchesBrand } from "./classifyIntent.js";
import { keywordKey, type KeywordRow } from "./readKeywordExport.js";
import type { SiteKeywords } from "./buildDomainReportExcel.js";
import { PRIORITY_FILL, finishSheet, geminiJson, headerRow, titleRow } from "./aiSeoAudit.js";

// Domain Intelligence report 4, Gap & Competitor Analysis (team's decision,
// 2026-10-23): keyword gaps, missed opportunities and actionable
// recommendations -- not a repeat of the Keyword Analysis' detailed data.
// Built from the same Semrush Positions exports as the Keyword Analysis'
// Competitors sheet (no extra Semrush steps), as an Excel workbook in the
// team's audit style. The gaps are worked out here; Gemini picks the
// opportunities worth pursuing (skipping ones that don't fit the client, e.g.
// another city's suburb) and writes the action plan. If Gemini is unavailable
// the workbook still has the Summary and Keyword Gaps sheets.

/** A competitor ranks within this position for a keyword to count as a gap. */
export const GAP_MAX_POSITION = 20;
/** The client ranks but outside the top 10 and behind a competitor -> "Weak". */
const WEAK_FROM = 11;
const MAX_GAP_ROWS = 200;

export interface SiteOverview {
  domain: string;
  keywords: number;
  top3: number;
  top10: number;
  traffic: number;
}

export interface GapRow {
  keyword: string;
  type: "Missing" | "Weak";
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  clientPosition: number | null;
  clientUrl: string | null;
  bestCompetitor: string;
  bestPosition: number;
  competitorUrl: string | null;
  competitorTraffic: number | null;
  /** How many of the competitors rank top 20 for it. */
  competitorsRanking: number;
}

export function siteOverview(site: SiteKeywords): SiteOverview {
  const ranked = site.rows.filter((r) => r.position !== null);
  return {
    domain: site.domain,
    keywords: ranked.length,
    top3: ranked.filter((r) => r.position! <= 3).length,
    top10: ranked.filter((r) => r.position! <= 10).length,
    traffic: Math.round(site.rows.reduce((sum, r) => sum + (r.traffic ?? 0), 0)),
  };
}

/** Keywords a competitor ranks top 20 for where the client is missing or weak; competitors' own brand searches left out. */
export function findGaps(client: SiteKeywords, competitors: SiteKeywords[], intentOf: (keyword: string) => string | null = () => null): GapRow[] {
  const clientByKey = new Map(client.rows.map((r) => [keywordKey(r.keyword), r]));
  const brands = competitors.flatMap((c) => brandTerms("", c.domain));
  const byKey = new Map<string, { rows: { domain: string; row: KeywordRow }[] }>();
  for (const c of competitors)
    for (const row of c.rows) {
      if (row.position === null || row.position > GAP_MAX_POSITION || matchesBrand(row.keyword, brands)) continue;
      const k = keywordKey(row.keyword);
      if (!byKey.has(k)) byKey.set(k, { rows: [] });
      byKey.get(k)!.rows.push({ domain: c.domain, row });
    }
  const gaps: GapRow[] = [];
  for (const [k, { rows }] of byKey) {
    const best = rows.reduce((a, b) => (b.row.position! < a.row.position! ? b : a));
    const mine = clientByKey.get(k);
    const myPos = mine?.position ?? null;
    let type: GapRow["type"] | null = null;
    if (myPos === null) type = "Missing";
    else if (myPos >= WEAK_FROM && myPos > best.row.position!) type = "Weak";
    if (!type) continue;
    // A search for another business ("tawa yoga", a teacher's name) is Navigational -- not a gap the client can win.
    const intent = intentOf(best.row.keyword) ?? best.row.sourceIntent ?? null;
    if (intent?.startsWith("Navigational")) continue;
    gaps.push({
      keyword: best.row.keyword,
      type,
      volume: best.row.volume ?? mine?.volume ?? null,
      difficulty: best.row.difficulty ?? mine?.difficulty ?? null,
      intent,
      clientPosition: myPos,
      clientUrl: mine?.url ?? null,
      bestCompetitor: best.domain,
      bestPosition: best.row.position!,
      competitorUrl: best.row.url ?? null,
      competitorTraffic: best.row.traffic ?? null,
      competitorsRanking: rows.length,
    });
  }
  // Most searched first; among equals, the easier one.
  return gaps.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || (a.difficulty ?? 100) - (b.difficulty ?? 100)).slice(0, MAX_GAP_ROWS);
}

// ---- Gemini: which gaps are worth it, and what to do ----

const Advice = z.object({
  summary: z.string(),
  keyFindings: z.array(z.string()),
  opportunities: z.array(
    z.object({
      priority: z.enum(["High", "Medium", "Low"]),
      keyword: z.string(),
      recommendation: z.string(),
      targetPage: z.string(),
    }),
  ),
  actionPlan: z.array(
    z.object({
      priority: z.enum(["High", "Medium", "Low"]),
      area: z.string(),
      action: z.string(),
      impact: z.string(),
      effort: z.enum(["Low", "Medium", "High"]),
      owner: z.string(),
    }),
  ),
});
export type GapAdvice = z.infer<typeof Advice>;

export type GapAdvisor = (input: { clientName: string; websiteUrl: string; overview: SiteOverview[]; gaps: GapRow[]; clientPages: string[] }) => Promise<GapAdvice>;

const PRIORITY = { type: "STRING", enum: ["High", "Medium", "Low"] };
const ADVICE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    keyFindings: { type: "ARRAY", items: { type: "STRING" } },
    opportunities: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { priority: PRIORITY, keyword: { type: "STRING" }, recommendation: { type: "STRING" }, targetPage: { type: "STRING" } },
        required: ["priority", "keyword", "recommendation", "targetPage"],
      },
    },
    actionPlan: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          priority: PRIORITY,
          area: { type: "STRING" },
          action: { type: "STRING" },
          impact: { type: "STRING" },
          effort: { type: "STRING", enum: ["Low", "Medium", "High"] },
          owner: { type: "STRING" },
        },
        required: ["priority", "area", "action", "impact", "effort", "owner"],
      },
    },
  },
  required: ["summary", "keyFindings", "opportunities", "actionPlan"],
};

const GAP_PROMPT = `You are a senior SEO strategist at SySpree Digital writing a keyword gap & competitor analysis for a client.
You get: the client and 3 competitors' Semrush overview (ranking keywords, top-3/top-10 counts, estimated monthly organic traffic),
the client's own ranking pages, and the keyword gaps ("Missing" = competitors rank top 20, client doesn't; "Weak" = client ranks
11+ and behind a competitor), each with volume, keyword difficulty (0-100), intent and the best competitor's ranking page.
Use ONLY these facts -- never invent numbers.
- summary: 3-5 sentences on where the client stands against the competitors and the size of the opportunity.
- keyFindings: 5-8 short, specific findings (e.g. which competitor wins which theme, quick-win count).
- opportunities: the 15-25 gaps MOST worth pursuing for THIS client. Skip keywords that don't fit its business or location
  (e.g. a suburb or city the client doesn't serve, a competitor's product names). Prefer good volume with low/medium difficulty
  and buying intent. recommendation = what to do in one sentence; targetPage = the client's existing page to improve (a URL from
  its ranking pages) or "New page: <short title>".
- actionPlan: 6-10 prioritised actions (High first) grouping the opportunities into work: new pages, page improvements,
  content clusters, internal links, local SEO, links -- with expected impact, effort and owner (e.g. "SEO / Content", "Dev / SEO").`;

export function createGeminiGapAdvisor(apiKey: string, model = process.env.GEMINI_AUDIT_MODEL || "gemini-flash-latest"): GapAdvisor {
  return async ({ clientName, websiteUrl, overview, gaps, clientPages }) => {
    const data = {
      client: { name: clientName, website: websiteUrl },
      overview,
      clientRankingPages: clientPages.slice(0, 60),
      gaps: gaps.slice(0, 150).map((g) => ({
        keyword: g.keyword,
        type: g.type,
        volume: g.volume,
        kd: g.difficulty,
        intent: g.intent,
        clientPosition: g.clientPosition,
        clientPage: g.clientUrl,
        bestCompetitor: g.bestCompetitor,
        bestPosition: g.bestPosition,
        competitorPage: g.competitorUrl,
      })),
    };
    const parsed = Advice.safeParse(await geminiJson(apiKey, model, GAP_PROMPT, [{ text: JSON.stringify(data) }], ADVICE_SCHEMA, "the Gap & Competitor Analysis"));
    if (!parsed.success) throw new Error("Gemini's answer wasn't a complete gap analysis.");
    return keepRealOpportunities(parsed.data, gaps);
  };
}

/**
 * "Missed Opportunities" lists real gaps only: a keyword Gemini came up with that isn't in the gap list was
 * written anyway, with blank numbers (audit 2026-10-27). Matched like everywhere else (keywordKey).
 */
export function keepRealOpportunities(advice: GapAdvice, gaps: GapRow[]): GapAdvice {
  const real = new Set(gaps.map((g) => keywordKey(g.keyword)));
  return { ...advice, opportunities: advice.opportunities.filter((o) => real.has(keywordKey(o.keyword))) };
}

// ---- the workbook ----

export async function buildGapWorkbook(input: {
  clientName: string;
  websiteUrl: string;
  dateLabel: string;
  overview: SiteOverview[];
  gaps: GapRow[];
  advice: GapAdvice | null;
  /** Why there's no advice (Gemini busy / no key), shown on the Summary. */
  adviceNote?: string;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const { overview, gaps, advice } = input;
  const missing = gaps.filter((g) => g.type === "Missing").length;
  const weak = gaps.length - missing;
  const quickWins = gaps.filter((g) => (g.difficulty ?? 100) <= 30 && (g.volume ?? 0) >= 50).length;

  // Summary
  const sum = wb.addWorksheet("Summary");
  [34, 14, 12, 12, 18].forEach((w, i) => (sum.getColumn(i + 1).width = w));
  titleRow(sum, `${input.clientName} — Keyword Gap & Competitor Analysis`, 5);
  sum.mergeCells(2, 1, 2, 5);
  sum.getCell(2, 1).value = `Source: Semrush Organic Positions (${input.dateLabel}) | Website: ${input.websiteUrl} | Competitors: ${overview
    .slice(1)
    .map((o) => o.domain)
    .join(", ")}`;
  sum.getCell(2, 1).font = { italic: true, color: { argb: "FF4B5563" } };
  headerRow(sum, 4, ["Domain", "Ranking keywords", "Top 3", "Top 10", "Est. monthly traffic"]);
  overview.forEach((o, i) => {
    const row = sum.getRow(5 + i);
    row.values = [i === 0 ? `${o.domain} (client)` : o.domain, o.keywords, o.top3, o.top10, o.traffic];
    if (i === 0) row.font = { bold: true };
  });
  let r = 5 + overview.length + 1;
  headerRow(sum, r, ["Gaps found", "Count"]);
  [
    ["Missing — competitors rank top 20, client doesn't", missing],
    ["Weak — client ranks 11+ and behind a competitor", weak],
    ["Quick wins — difficulty ≤ 30, volume ≥ 50", quickWins],
  ].forEach(([label, n], i) => (sum.getRow(r + 1 + i).values = [label, n]));
  r += 5;
  sum.getCell(r, 1).value = "Summary";
  sum.getCell(r, 1).font = { bold: true };
  sum.mergeCells(r + 1, 1, r + 1, 5);
  sum.getCell(r + 1, 1).value = advice?.summary ?? input.adviceNote ?? "";
  sum.getCell(r + 1, 1).alignment = { wrapText: true, vertical: "top" };
  sum.getRow(r + 1).height = 75;
  if (advice?.keyFindings.length) {
    sum.getCell(r + 3, 1).value = "Key Findings";
    sum.getCell(r + 3, 1).font = { bold: true };
    advice.keyFindings.forEach((f, i) => {
      sum.mergeCells(r + 4 + i, 1, r + 4 + i, 5);
      sum.getCell(r + 4 + i, 1).value = `• ${f}`;
      sum.getCell(r + 4 + i, 1).alignment = { wrapText: true, vertical: "top" };
    });
  }
  sum.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // Keyword Gaps
  const gs = wb.addWorksheet("Keyword Gaps");
  [34, 10, 10, 10, 15, 12, 18, 22, 12, 42].forEach((w, i) => (gs.getColumn(i + 1).width = w));
  titleRow(gs, `Keyword Gaps — competitors rank top ${GAP_MAX_POSITION}, ${input.clientName} is missing or weak`, 10);
  headerRow(gs, 3, ["Keyword", "Gap", "Volume", "KD", "Intent", "Client position", "Competitors ranking", "Best competitor", "Their position", "Their ranking page"]);
  gaps.forEach((g, i) => {
    const row = gs.getRow(4 + i);
    row.values = [g.keyword, g.type, g.volume, g.difficulty, g.intent, g.clientPosition ?? "—", g.competitorsRanking, g.bestCompetitor, g.bestPosition, g.competitorUrl];
    row.getCell(2).font = { bold: true, color: { argb: g.type === "Missing" ? "FFB91C1C" : "FFB45309" } };
  });
  finishSheet(gs, 3, 10, 3 + gaps.length);

  if (advice) {
    // Missed Opportunities -- Gemini's pick, with the gap's numbers alongside.
    const byKey = new Map(gaps.map((g) => [keywordKey(g.keyword), g]));
    const os = wb.addWorksheet("Missed Opportunities");
    [10, 30, 10, 8, 10, 22, 55, 40].forEach((w, i) => (os.getColumn(i + 1).width = w));
    titleRow(os, "Missed Opportunities — the gaps worth pursuing", 8);
    headerRow(os, 3, ["Priority", "Keyword", "Volume", "KD", "Gap", "Best competitor", "Recommendation", "Target page"]);
    const order = { High: 0, Medium: 1, Low: 2 };
    const opps = [...advice.opportunities].sort((a, b) => order[a.priority] - order[b.priority]);
    opps.forEach((o, i) => {
      const g = byKey.get(keywordKey(o.keyword));
      const row = os.getRow(4 + i);
      row.values = [o.priority, o.keyword, g?.volume ?? null, g?.difficulty ?? null, g?.type ?? null, g ? `${g.bestCompetitor} (#${g.bestPosition})` : null, o.recommendation, o.targetPage];
      row.alignment = { vertical: "top", wrapText: true };
      row.getCell(1).font = { bold: true };
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: PRIORITY_FILL[o.priority] } };
    });
    finishSheet(os, 3, 8, 3 + opps.length);

    // Action Plan
    const plan = wb.addWorksheet("Action Plan");
    [10, 22, 62, 50, 12, 18].forEach((w, i) => (plan.getColumn(i + 1).width = w));
    titleRow(plan, "Prioritized Action Plan", 6);
    headerRow(plan, 3, ["Priority", "Area", "Action Item", "Expected Impact", "Effort", "Owner"]);
    const actions = [...advice.actionPlan].sort((a, b) => order[a.priority] - order[b.priority]);
    actions.forEach((a, i) => {
      const row = plan.getRow(4 + i);
      row.values = [a.priority, a.area, a.action, a.impact, a.effort, a.owner];
      row.alignment = { vertical: "top", wrapText: true };
      row.getCell(1).font = { bold: true };
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: PRIORITY_FILL[a.priority] } };
    });
    finishSheet(plan, 3, 6, 3 + actions.length);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
