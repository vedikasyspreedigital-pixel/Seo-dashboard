import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { formatOrdinalDate } from "../reporting/formatOrdinalDate.js";
import { KeywordExportError, SOURCE_LABELS, keywordKey, readKeywordExport, type KeywordExport, type KeywordSource } from "./readKeywordExport.js";
import { classifyIntents, INTENTS, type ClassifyWithAiFn, type Intent } from "./classifyIntent.js";
import { buildDomainReportExcel, competitorSheetRows, type CompetitorSheet, type ReportBlock, type SiteKeywords } from "./buildDomainReportExcel.js";
import { bareDomain } from "./fetchers/flikoverAhrefs.js";
import { buildGapWorkbook, findGaps, siteOverview, type GapAdvice, type GapAdvisor } from "./gapReport.js";
import type { PostCommentFn } from "./clickupCommentPoster.js";

// Domain Intelligence pipeline: uploaded tool exports -> intent -> Excel
// report(s) saved under REPORTS_DIR/domain-intel/<reportId>/ -> posted as a
// comment on the client's domain-report ClickUp task. Generation and posting
// are separate steps so a failed post can be retried without regenerating.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.resolve(__dirname, "../../reports");

/** Where a domain report's files (and, for automatic fetches, its input exports) live. */
export const domainReportDir = (reportId: string) => path.join(REPORTS_DIR, "domain-intel", reportId);

export type ReportMode = "combined" | "individual" | "both";
export const REPORT_MODES: ReportMode[] = ["combined", "individual", "both"];
export const SOURCES: KeywordSource[] = ["semrush", "ubersuggest", "ahrefs"];

/** Countries offered for the tools' Google database (Semrush codes). */
export const LOCATIONS = ["au", "us", "uk", "ca", "nz", "in", "ae", "sa", "qa", "sg"] as const;

export interface CreateDomainReportInput {
  client: { id: string; name: string };
  websiteUrl: string;
  location: string | null;
  reportMode: ReportMode;
  uploads: Partial<Record<KeywordSource, { buffer: Buffer; name: string }>>;
  /** Up to 3 competitors' Semrush Positions exports -> the side-by-side "Competitors" sheet. */
  competitors?: { domain: string; buffer: Buffer; name: string }[];
  createdBy: string | null;
  domainReportTaskId: string | null;
}

export interface ReportFile {
  name: string;
  path: string;
}

export async function createDomainReport(input: CreateDomainReportInput, classifyWithAi?: ClassifyWithAiFn | null, gapAdvisor?: GapAdvisor | null) {
  const exports: KeywordExport[] = [];
  const problems: string[] = [];
  for (const source of SOURCES) {
    const upload = input.uploads[source];
    if (!upload) continue;
    try {
      exports.push(await readKeywordExport(source, upload.buffer, upload.name));
    } catch (err) {
      if (err instanceof KeywordExportError) problems.push(err.message);
      else throw err;
    }
  }
  const competitors: SiteKeywords[] = [];
  for (const c of input.competitors ?? []) {
    try {
      competitors.push({ domain: c.domain, rows: (await readKeywordExport("semrush", c.buffer, c.name)).rows });
    } catch (err) {
      if (err instanceof KeywordExportError) problems.push(`${c.domain}: ${err.message}`);
      else throw err;
    }
  }
  if (problems.length > 0) throw new KeywordExportError(problems.join(" "));
  if (exports.length === 0) throw new KeywordExportError("Upload at least one export (Semrush, Ubersuggest or Ahrefs).");
  const clientSemrush = exports.find((e) => e.source === "semrush");
  if (competitors.length > 0 && !clientSemrush) {
    throw new KeywordExportError("Fetch or upload the client's Semrush export too -- the competitor sheet compares Semrush data with Semrush data.");
  }
  const sheetBase: CompetitorSheet | null =
    clientSemrush && competitors.length > 0 ? { client: { domain: bareDomain(input.websiteUrl), rows: clientSemrush.rows }, competitors, intentOf: () => "" } : null;
  // Only the competitors' keywords that make it onto the sheet need an intent.
  const competitorKeywords = sheetBase ? competitorSheetRows(sheetBase).map((r) => r.keyword) : [];
  const competitorRows = new Map(competitors.flatMap((c) => c.rows).map((r) => [keywordKey(r.keyword), r]));

  // ONE intent per keyword, the same in every tool's block. The tools' own
  // labels (Semrush's "Keyword Intents", Ahrefs' intent columns -- often
  // several at once) are only hints for it (classifyIntent.ts).
  const toolLabels = new Map<string, string[]>();
  const addLabel = (r: { keyword: string; sourceIntent?: string | null }) => {
    if (r.sourceIntent) toolLabels.set(keywordKey(r.keyword), [...(toolLabels.get(keywordKey(r.keyword)) ?? []), r.sourceIntent]);
  };
  for (const e of exports) e.rows.forEach(addLabel);
  for (const k of competitorKeywords) {
    const r = competitorRows.get(keywordKey(k));
    if (r && !toolLabels.has(keywordKey(k))) addLabel(r);
  }
  const allKeywords = [...exports.flatMap((e) => e.rows.map((r) => r.keyword)), ...competitorKeywords];
  const intent = await classifyIntents(allKeywords, { clientName: input.client.name, websiteUrl: input.websiteUrl }, classifyWithAi, toolLabels);
  const blocks: ReportBlock[] = exports.map((e) => ({
    source: e.source,
    rows: e.rows.map((r) => ({ ...r, intent: intent.intents.get(keywordKey(r.keyword)) ?? "Informational" })),
  }));

  const intentCounts = Object.fromEntries(INTENTS.map((i) => [i, 0])) as Record<Intent, number>;
  for (const block of blocks) for (const row of block.rows) if (row.intent in intentCounts) intentCounts[row.intent as Intent]++;

  const created = await prisma.domainReport.create({
    data: {
      clientId: input.client.id,
      websiteUrl: input.websiteUrl,
      location: input.location,
      sources: exports.map((e) => e.source),
      reportMode: input.reportMode,
      summary: {},
      files: [],
      createdBy: input.createdBy,
      clickupTaskId: input.domainReportTaskId,
      status: "GENERATING",
    },
  });

  const dir = domainReportDir(created.id);
  await mkdir(dir, { recursive: true });
  const date = formatOrdinalDate(new Date());
  const clientLabel = input.client.name.replace(/[\\/:*?"<>|]/g, "").trim() || "Client";
  const files: ReportFile[] = [];
  const sheet: CompetitorSheet | null = sheetBase ? { ...sheetBase, intentOf: (k) => intent.intents.get(keywordKey(k)) ?? "Informational" } : null;
  const save = async (name: string, reportBlocks: ReportBlock[], withCompetitors: boolean) => {
    const filePath = path.join(dir, name);
    await writeFile(filePath, await buildDomainReportExcel(reportBlocks, withCompetitors ? sheet : null));
    files.push({ name, path: filePath });
  };
  // The competitor sheet goes in the combined report -- or, with individual files only, in the Semrush one.
  if (input.reportMode !== "individual") await save(`${clientLabel} - Domain Keyword Report - ${date}.xlsx`, blocks, true);
  if (input.reportMode !== "combined") {
    for (const block of blocks)
      await save(`${clientLabel} - ${SOURCE_LABELS[block.source]} Keywords - ${date}.xlsx`, [block], input.reportMode === "individual" && block.source === "semrush");
  }

  // Report 4, Gap & Competitor Analysis -- from the same competitor data. Gemini's part is optional:
  // without it (no key, or busy) the workbook still has the Summary and Keyword Gaps.
  let gapSummary: { missing: number; weak: number; opportunities: number | null } | null = null;
  if (sheet) {
    const overview = [sheet.client, ...sheet.competitors].map(siteOverview);
    const gaps = findGaps(sheet.client, sheet.competitors, sheet.intentOf);
    let advice: GapAdvice | null = null;
    let adviceNote: string | undefined;
    if (gapAdvisor) {
      try {
        advice = await gapAdvisor({
          clientName: input.client.name,
          websiteUrl: input.websiteUrl,
          overview,
          gaps,
          clientPages: [...new Set(sheet.client.rows.map((r) => r.url).filter((u): u is string => !!u))],
        });
      } catch (err) {
        console.error(`[domainIntel] gap analysis advice failed:`, (err as Error).message);
        adviceNote = `Recommendations couldn't be written this time (${(err as Error).message}) -- the gap data below is complete.`;
      }
    } else adviceNote = "Recommendations need Gemini (GEMINI_API_KEY isn't set on this server) -- the gap data below is complete.";
    const name = `${clientLabel} - Gap & Competitor Analysis - ${date}.xlsx`;
    const filePath = path.join(dir, name);
    await writeFile(filePath, await buildGapWorkbook({ clientName: input.client.name, websiteUrl: input.websiteUrl, dateLabel: date, overview, gaps, advice, adviceNote }));
    files.push({ name, path: filePath });
    gapSummary = { missing: gaps.filter((g) => g.type === "Missing").length, weak: gaps.filter((g) => g.type === "Weak").length, opportunities: advice?.opportunities.length ?? null };
  }

  return prisma.domainReport.update({
    where: { id: created.id },
    data: {
      files: files.map((f) => ({ name: f.name, path: f.path })),
      summary: {
        sources: Object.fromEntries(exports.map((e) => [e.source, { keywords: e.rows.length, duplicatesRemoved: e.duplicatesRemoved }])),
        competitors: competitors.map((c) => ({ domain: c.domain, keywords: c.rows.length })),
        gaps: gapSummary,
        intents: intentCounts,
        // Unique keywords decided by each step (a keyword in several tools counts once).
        intentFromSource: intent.byToolLabels,
        intentByPattern: intent.byPattern,
        intentByAi: intent.byAi,
        intentUnresolved: intent.unresolved,
      },
      // No domain task configured: kept, downloadable, just not posted.
      status: input.domainReportTaskId ? "GENERATED" : "NOT_POSTED",
      error: input.domainReportTaskId ? null : "No domain-report ClickUp task ID is set for this client (Client Management).",
    },
  });
}

/**
 * Posts a generated report to its ClickUp task. Never throws -- the outcome is
 * recorded on the report (POSTED / POST_FAILED with the reason) so the page
 * can show it and offer a retry.
 */
export async function postDomainReport(reportId: string, postComment: PostCommentFn): Promise<void> {
  const report = await prisma.domainReport.findUnique({
    where: { id: reportId },
    include: { client: { select: { name: true, domainReportTaskId: true, workspace: { select: { slug: true } } } } },
  });
  if (!report) return;
  const taskId = report.client.domainReportTaskId;
  if (!taskId) {
    await prisma.domainReport.update({
      where: { id: reportId },
      data: { status: "NOT_POSTED", error: "No domain-report ClickUp task ID is set for this client (Client Management)." },
    });
    return;
  }

  await prisma.domainReport.update({ where: { id: reportId }, data: { status: "POSTING", clickupTaskId: taskId, error: null } });
  const summary = report.summary as { sources?: Record<string, { keywords: number }> };
  const counts = Object.entries(summary.sources ?? {})
    .map(([source, s]) => `${SOURCE_LABELS[source as KeywordSource] ?? source}: ${s.keywords} keywords`)
    .join(" · ");
  const marker = `Ref DI-${report.id.slice(0, 8)}`;
  try {
    await postComment({
      taskId,
      workspaceSlug: report.client.workspace?.slug ?? null,
      lines: [`Domain keyword report for ${report.client.name} (${report.websiteUrl}) — ${formatOrdinalDate(report.createdAt)}`, counts, marker],
      marker,
      files: report.files as unknown as ReportFile[],
    });
    await prisma.domainReport.update({ where: { id: reportId }, data: { status: "POSTED", postedAt: new Date(), error: null } });
  } catch (err) {
    console.error(`[domainIntel] posting report ${reportId} to ClickUp task ${taskId} failed:`, err);
    await prisma.domainReport.update({ where: { id: reportId }, data: { status: "POST_FAILED", error: (err as Error).message.slice(0, 1000) } });
  }
}
