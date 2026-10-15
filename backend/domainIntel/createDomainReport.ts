import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { formatOrdinalDate } from "../reporting/formatOrdinalDate.js";
import { KeywordExportError, SOURCE_LABELS, keywordKey, readKeywordExport, type KeywordExport, type KeywordSource } from "./readKeywordExport.js";
import { classifyIntents, INTENTS, type ClassifyWithAiFn, type Intent } from "./classifyIntent.js";
import { buildDomainReportExcel, type ReportBlock } from "./buildDomainReportExcel.js";
import type { PostCommentFn } from "./clickupCommentPoster.js";

// Domain Intelligence pipeline: uploaded tool exports -> intent -> Excel
// report(s) saved under REPORTS_DIR/domain-intel/<reportId>/ -> posted as a
// comment on the client's domain-report ClickUp task. Generation and posting
// are separate steps so a failed post can be retried without regenerating.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.resolve(__dirname, "../../reports");

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
  createdBy: string | null;
  domainReportTaskId: string | null;
}

export interface ReportFile {
  name: string;
  path: string;
}

export async function createDomainReport(input: CreateDomainReportInput, classifyWithAi?: ClassifyWithAiFn | null) {
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
  if (problems.length > 0) throw new KeywordExportError(problems.join(" "));
  if (exports.length === 0) throw new KeywordExportError("Upload at least one export (Semrush, Ubersuggest or Ahrefs).");

  // A tool's own intent (Semrush's "Keyword Intents") is kept as-is; only rows
  // without one (Ubersuggest, Ahrefs) get a generated intent.
  const needIntent = exports.flatMap((e) => e.rows.filter((r) => !r.sourceIntent).map((r) => r.keyword));
  const intent = await classifyIntents(needIntent, { clientName: input.client.name, websiteUrl: input.websiteUrl }, classifyWithAi);
  const blocks: ReportBlock[] = exports.map((e) => ({
    source: e.source,
    rows: e.rows.map((r) => ({ ...r, intent: r.sourceIntent || intent.intents.get(keywordKey(r.keyword)) || "Informational" })),
  }));

  // A mixed intent ("Informational, Transactional") counts towards each of its labels.
  const intentCounts = Object.fromEntries(INTENTS.map((i) => [i, 0])) as Record<Intent, number>;
  for (const block of blocks)
    for (const row of block.rows)
      for (const label of row.intent.split(", ")) if (label in intentCounts) intentCounts[label as Intent]++;
  const intentFromSource = exports.reduce((n, e) => n + e.rows.filter((r) => r.sourceIntent).length, 0);

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

  const dir = path.join(REPORTS_DIR, "domain-intel", created.id);
  await mkdir(dir, { recursive: true });
  const date = formatOrdinalDate(new Date());
  const clientLabel = input.client.name.replace(/[\\/:*?"<>|]/g, "").trim() || "Client";
  const files: ReportFile[] = [];
  const save = async (name: string, reportBlocks: ReportBlock[]) => {
    const filePath = path.join(dir, name);
    await writeFile(filePath, await buildDomainReportExcel(reportBlocks));
    files.push({ name, path: filePath });
  };
  if (input.reportMode !== "individual") await save(`${clientLabel} - Domain Keyword Report - ${date}.xlsx`, blocks);
  if (input.reportMode !== "combined") {
    for (const block of blocks) await save(`${clientLabel} - ${SOURCE_LABELS[block.source]} Keywords - ${date}.xlsx`, [block]);
  }

  return prisma.domainReport.update({
    where: { id: created.id },
    data: {
      files: files.map((f) => ({ name: f.name, path: f.path })),
      summary: {
        sources: Object.fromEntries(exports.map((e) => [e.source, { keywords: e.rows.length, duplicatesRemoved: e.duplicatesRemoved }])),
        intents: intentCounts,
        intentFromSource,
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
