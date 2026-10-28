import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { isMock } from "../reporting/mockEmailSender.js";

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
  // Anything failing from here on used to leave the report "Generating" for good -- the page kept waiting
  // and posting was refused as "still being processed" (audit 2026-10-27). Now it's marked FAILED with the
  // reason, the half-built files go, and the error still reaches the caller as before.
  try {
    return await buildReportFiles();
  } catch (err) {
    await prisma.domainReport
      .update({ where: { id: created.id }, data: { status: "FAILED", error: `Couldn't build the files: ${(err as Error).message}`.slice(0, 1000) } })
      .catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  async function buildReportFiles() {
  await mkdir(dir, { recursive: true });
  const date = formatOrdinalDate(new Date());
  const clientLabel = safeFileName(input.client.name) || "Client";
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
      error: input.domainReportTaskId ? null : "No ClickUp task was given, so the files are for download only.",
    },
  });
  }
}

/**
 * Disk space (user's choice, 2026-10-26): a report's files are deleted 10 days after it was POSTED to
 * ClickUp -- the comment keeps them. The history row stays (summary.filesExpired). Reports that never
 * reached ClickUp keep their files: the server copy is the only one.
 */
export const REPORT_FILES_KEEP_DAYS = 10;

export async function removeExpiredReportFiles(now = new Date(), onlyClientId?: string): Promise<number> {
  const cutoff = new Date(now.getTime() - REPORT_FILES_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.domainReport.findMany({ where: { status: "POSTED", postedAt: { lt: cutoff }, ...(onlyClientId ? { clientId: onlyClientId } : {}) } });
  let removed = 0;
  for (const report of expired) {
    if ((report.files as unknown as ReportFile[]).length === 0) continue;
    // "Posted" in test mode reached no ClickUp comment -- the server copy is the only one.
    if ((report.summary as { mockPosted?: boolean } | null)?.mockPosted) continue;
    await rm(domainReportDir(report.id), { recursive: true, force: true }).catch(() => {});
    await prisma.domainReport.update({
      where: { id: report.id },
      data: { files: [], summary: { ...(report.summary as object), filesExpired: true } },
    });
    removed++;
  }
  if (removed > 0) console.log(`[domainIntel] removed the files of ${removed} report(s) posted more than ${REPORT_FILES_KEEP_DAYS} days ago`);
  return removed;
}

/** A client name or file name made safe as one file name: no path separators, reserved or control characters. */
export const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();

/** Adds more files (e.g. the audits of a "Run all 5 reports") to a report, so one comment carries them all. */
export async function attachFilesToReport(reportId: string, extra: { name: string; buffer: Buffer }[]) {
  const report = await prisma.domainReport.findUniqueOrThrow({ where: { id: reportId } });
  const dir = domainReportDir(reportId);
  await mkdir(dir, { recursive: true });
  const files = [...(report.files as unknown as ReportFile[])];
  for (const f of extra) {
    // The stored name is cleaned too: the comment poster saves each file under it (a "/" in a client name broke every post).
    const name = safeFileName(f.name) || "file";
    const filePath = path.join(dir, name);
    await writeFile(filePath, f.buffer);
    files.push({ name, path: filePath });
  }
  return prisma.domainReport.update({ where: { id: reportId }, data: { files: files.map((f) => ({ name: f.name, path: f.path })) } });
}

/**
 * Keeps only the files `keep` says yes to (deleted from disk too) -- for a run where only some reports were
 * picked, e.g. the Gap report without the Keyword Analysis it was built from (the user's choice, 2026-10-27).
 */
export async function keepReportFiles(reportId: string, keep: (name: string) => boolean) {
  const report = await prisma.domainReport.findUniqueOrThrow({ where: { id: reportId } });
  const files = report.files as unknown as ReportFile[];
  for (const f of files.filter((f) => !keep(f.name))) await rm(f.path, { force: true }).catch(() => {});
  return prisma.domainReport.update({ where: { id: reportId }, data: { files: files.filter((f) => keep(f.name)).map((f) => ({ name: f.name, path: f.path })) } });
}

/** A report with no keyword files yet -- holds the audits of a run where no keyword report was picked. */
export async function createAuditsOnlyReport(input: { client: { id: string }; websiteUrl: string; createdBy: string | null; domainReportTaskId: string | null }) {
  return prisma.domainReport.create({
    data: {
      clientId: input.client.id,
      websiteUrl: input.websiteUrl,
      sources: [],
      reportMode: "combined",
      summary: { auditsOnly: true },
      files: [],
      createdBy: input.createdBy,
      status: input.domainReportTaskId ? "GENERATED" : "NOT_POSTED",
      error: input.domainReportTaskId ? null : "No ClickUp task was given, so the files are for download only.",
    },
  });
}

/** Who the report comment tags (the user's choice, 2026-10-26) -- a real ClickUp @mention, so he's notified. */
export const COMMENT_MENTION = "Farid Ansari";

/**
 * Posts a generated report to its ClickUp task. Never throws -- the outcome is
 * recorded on the report (POSTED / POST_FAILED with the reason) so the page
 * can show it and offer a retry.
 */
export async function postDomainReport(reportId: string, postComment: PostCommentFn): Promise<void> {
  // One post per report at a time: a second click (the history's Retry, the run's "Post all 5", a double
  // click) while a post is running must never start a second browser posting the same comment (audit
  // 2026-10-27). The set is per process; the server runs as one instance.
  if (postingNow.has(reportId)) return;
  postingNow.add(reportId);
  try {
    await postDomainReportOnce(reportId, postComment);
  } finally {
    postingNow.delete(reportId);
  }
}

const postingNow = new Set<string>();

/** True while this server is posting the report -- a POSTING report that isn't was cut off by a restart. */
export const isPostingNow = (reportId: string) => postingNow.has(reportId);

async function postDomainReportOnce(reportId: string, postComment: PostCommentFn): Promise<void> {
  const report = await prisma.domainReport.findUnique({
    where: { id: reportId },
    include: { client: { select: { name: true, domainReportTaskId: true, workspace: { select: { slug: true } } } } },
  });
  if (!report) return;
  const taskId = report.client.domainReportTaskId;
  if (!taskId) {
    await prisma.domainReport.update({
      where: { id: reportId },
      data: { status: "NOT_POSTED", error: "No ClickUp task was given, so the files are for download only." },
    });
    return;
  }

  // Claimed atomically: a report already POSTED (or still GENERATING) is never posted again.
  const claimed = await prisma.domainReport.updateMany({
    where: { id: reportId, status: { in: ["GENERATED", "POST_FAILED", "NOT_POSTED", "POSTING"] } },
    data: { status: "POSTING", clickupTaskId: taskId, error: null },
  });
  if (claimed.count === 0) return;
  const marker = `Ref DI-${report.id.slice(0, 8)}`;
  try {
    await postComment({
      taskId,
      workspaceSlug: report.client.workspace?.slug ?? null,
      // The team's wording (2026-10-26), tagging the SEO head. The marker line stays: it's how the poster
      // confirms the comment landed and never posts the same report twice.
      lines: [`Hii @${COMMENT_MENTION} sir, here is the Seo reports and Audit for ${report.websiteUrl}`, marker],
      mention: COMMENT_MENTION,
      marker,
      files: report.files as unknown as ReportFile[],
    });
    // Test mode: marked, so the page says nothing reached ClickUp and the files are never auto-deleted.
    const mockPosted = isMock(postComment) ? { summary: { ...(report.summary as object), mockPosted: true } } : {};
    await prisma.domainReport.update({ where: { id: reportId }, data: { status: "POSTED", postedAt: new Date(), error: null, ...mockPosted } });
  } catch (err) {
    console.error(`[domainIntel] posting report ${reportId} to ClickUp task ${taskId} failed:`, err);
    await prisma.domainReport.update({ where: { id: reportId }, data: { status: "POST_FAILED", error: (err as Error).message.slice(0, 1000) } });
  }
}
