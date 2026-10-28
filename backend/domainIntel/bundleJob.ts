import { randomUUID } from "node:crypto";
import { prisma } from "../db/client.js";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KeywordSource } from "./readKeywordExport.js";
import { SOURCE_LABELS } from "./readKeywordExport.js";
import type { FetchExportFn } from "./fetchers/flikoverAhrefs.js";
import { bareDomain } from "./fetchers/flikoverAhrefs.js";
import { fetchedCompetitorExport, fetchedExport, getJob, startFetch } from "./fetchJob.js";
import { COMPETITOR_COUNT, getCompetitorSearch, startCompetitorSearch } from "./competitorJob.js";
import { AUDIT_LABELS, AuditJobError, getAudit, latestAudits, startAudit, type AuditKind } from "./auditJob.js";
import { attachFilesToReport, createAuditsOnlyReport, createDomainReport, domainReportDir, keepReportFiles, postDomainReport, type ReportMode } from "./createDomainReport.js";
import type { ClassifyWithAiFn } from "./classifyIntent.js";
import type { GapAdvisor } from "./gapReport.js";
import type { AiAuditWriter } from "./aiSeoAudit.js";
import type { PostCommentFn } from "./clickupCommentPoster.js";

// "Run all 5 reports" (user's plan, 2026-10-26): one click on the Domain
// Intelligence page runs the whole thing ON THE SERVER, so closing the tab
// doesn't stop it, and the page picks the progress up again. In order (the
// office Chrome agent does one job at a time anyway):
//   1. competitors (typed by the team, or Semrush's top 3) and the keyword
//      exports -- the client's tools + each competitor's Semrush positions
//   2. Keyword Analysis + Gap & Competitor files, while the agent goes on to
//      3. the Semrush Site Audit and 4. the WooRank audit
//   5. the AI SEO Audit (needs at least one of 3/4)
//   then ONE ClickUp comment with every file. A part that fails doesn't stop
// the others; posting is automatic only when all 5 are there -- otherwise the
// report waits with whatever is ready, and the page offers to post it.
// Runs are kept in memory and saved to disk on every change, so a finished one
// survives a restart/deploy (a run cut off mid-way is shown as stopped).
//
// Not always all 5 (user's choice, 2026-10-27): the team ticks the reports it wants. Only those run and only
// their files go into the comment. The Gap report still needs the keyword data (fetched, but the Keyword
// Analysis file is left out if it wasn't ticked); the AI SEO Audit needs the Site Audit AND WooRank ticked.

export type BundlePart = "keywords" | "gap" | "siteaudit" | "woorank" | "aiaudit" | "post";
export const BUNDLE_PARTS: BundlePart[] = ["keywords", "gap", "siteaudit", "woorank", "aiaudit", "post"];
export type BundleReport = Exclude<BundlePart, "post">;
export const BUNDLE_REPORTS: BundleReport[] = ["keywords", "gap", "siteaudit", "woorank", "aiaudit"];
const AUDIT_PARTS = ["siteaudit", "woorank", "aiaudit"] as const;
const GAP_FILE = "Gap & Competitor";
/** Runs saved before 2026-10-27 have no `selected` -- they were all 5. */
const selectedOf = (job: BundleJob): BundleReport[] => job.selected ?? BUNDLE_REPORTS;
export type PartState = "waiting" | "running" | "done" | "failed" | "skipped";

export interface BundleJob {
  id: string;
  clientId: string;
  clientName: string;
  workspaceId: string | null;
  websiteUrl: string;
  /** Who started it, the country and the ClickUp task -- so the page can show the form again (missing on runs before 2026-10-28). */
  createdBy?: string | null;
  location?: string | null;
  clickupTaskId?: string | null;
  state: "running" | "done" | "attention";
  parts: Record<BundlePart, { state: PartState; step?: string; error?: string }>;
  /** The reports the team ticked (missing on runs saved before 2026-10-27 = all 5). */
  selected?: BundleReport[];
  competitors: string[];
  /** The audit jobs this run started (their files go into the report). */
  auditIds: Partial<Record<AuditKind, string>>;
  /** Which audits' files are already in the report (so a later "post" adds only the missing ones). */
  attachedAudits: AuditKind[];
  /** The DomainReport holding every file (download + posting). */
  reportId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BundleInput {
  client: { id: string; workspaceId: string | null; name: string; domainReportTaskId: string | null };
  websiteUrl: string;
  location: string | null;
  sources: KeywordSource[];
  /** Typed by the team, or "auto" = Semrush's top 3, or [] = none. */
  competitors: string[] | "auto";
  reportMode: ReportMode;
  createdBy: string | null;
  /** The reports to make; omitted = all 5. */
  reports?: BundleReport[];
}

export interface BundleDeps {
  fetchers: Partial<Record<KeywordSource, FetchExportFn>>;
  competitorFetcher?: FetchExportFn;
  auditFetchers: Partial<Record<AuditKind, FetchExportFn>>;
  aiAuditWriter?: AiAuditWriter | null;
  classifyWithAi?: ClassifyWithAiFn | null;
  gapAdvisor?: GapAdvisor | null;
  postComment: PostCommentFn;
  /** How often waiting steps check on their jobs (tests use a few ms). */
  pollMs?: number;
}

export class BundleJobError extends Error {}

const KEEP_MS = 24 * 60 * 60 * 1000;
const jobs = new Map<string, BundleJob>();

function touch(job: BundleJob) {
  job.updatedAt = new Date().toISOString();
  void saveBundle(job);
}

// Saved to disk on every change (they're small), so a finished run -- waiting for a retried audit to be
// posted -- survives a restart or a deploy. A run cut off mid-way is shown as stopped.
const bundleDir = () => domainReportDir("bundles");
async function saveBundle(job: BundleJob) {
  try {
    await mkdir(bundleDir(), { recursive: true });
    await writeFile(path.join(bundleDir(), `${job.id}.json`), JSON.stringify(job));
  } catch {
    // best effort -- the run itself carries on
  }
}

/** Called once at server start. */
export async function loadSavedBundles() {
  const names = await readdir(bundleDir()).catch(() => [] as string[]);
  const cutoff = Date.now() - KEEP_MS;
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const file = path.join(bundleDir(), name);
    try {
      const job = JSON.parse(await readFile(file, "utf8")) as BundleJob;
      if (Date.parse(job.updatedAt) < cutoff) {
        await rm(file, { force: true });
        continue;
      }
      job.attachedAudits ??= [];
      if (job.state === "running") {
        job.state = "attention";
        for (const p of BUNDLE_PARTS)
          if (job.parts[p].state === "running" || job.parts[p].state === "waiting")
            job.parts[p] = { state: "failed", error: "Stopped: the server restarted during the run -- retry it in the Audits section or run all again" };
      }
      jobs.set(job.id, job);
    } catch {
      // unreadable -- skip
    }
  }
}
function setPart(job: BundleJob, part: BundlePart, patch: BundleJob["parts"][BundlePart]) {
  job.parts[part] = patch;
  touch(job);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined, done: (t: T) => boolean, pollMs: number, onTick?: (t: T) => void): Promise<T> {
  for (;;) {
    const value = read();
    if (!value) throw new Error("The job disappeared (the server may have restarted).");
    onTick?.(value);
    if (done(value)) return value;
    await sleep(pollMs);
  }
}

export function startBundle(input: BundleInput, deps: BundleDeps): BundleJob {
  const running = [...jobs.values()].find((j) => j.clientId === input.client.id && j.state === "running");
  if (running) return running; // a double-click never starts a second run
  const selected = input.reports ? BUNDLE_REPORTS.filter((r) => input.reports!.includes(r)) : BUNDLE_REPORTS;
  if (selected.length === 0) throw new BundleJobError("Tick at least one report.");
  if (selected.includes("aiaudit") && !(selected.includes("siteaudit") && selected.includes("woorank")))
    throw new BundleJobError("The AI SEO Audit is written from the Site Audit and the WooRank audit -- tick both of them too.");
  const usable = input.sources.filter((s) => deps.fetchers[s]);
  if ((selected.includes("keywords") || selected.includes("gap")) && usable.length === 0)
    throw new BundleJobError("None of the chosen keyword tools can be fetched automatically on this server (the office Chrome agent isn't set up).");
  if ((selected.includes("siteaudit") && !deps.auditFetchers.siteaudit) || (selected.includes("woorank") && !deps.auditFetchers.woorank))
    throw new BundleJobError("The audits need the office Chrome agent, which isn't set up on this server.");
  const cutoff = Date.now() - KEEP_MS;
  for (const j of jobs.values())
    if (j.state !== "running" && Date.parse(j.updatedAt) < cutoff) {
      jobs.delete(j.id);
      void rm(path.join(bundleDir(), `${j.id}.json`), { force: true }).catch(() => {});
    }

  const now = new Date().toISOString();
  const job: BundleJob = {
    id: randomUUID(),
    clientId: input.client.id,
    clientName: input.client.name,
    workspaceId: input.client.workspaceId,
    websiteUrl: input.websiteUrl,
    createdBy: input.createdBy,
    location: input.location,
    clickupTaskId: input.client.domainReportTaskId,
    state: "running",
    parts: Object.fromEntries(
      BUNDLE_PARTS.map((p) => [p, p === "post" || selected.includes(p) ? { state: "waiting" } : { state: "skipped", step: "Not selected" }]),
    ) as BundleJob["parts"],
    selected,
    competitors: [],
    auditIds: {},
    attachedAudits: [],
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  void run(job, { ...input, sources: usable }, deps).catch((err) => {
    console.error(`[domainIntel] run-all ${job.id} stopped:`, err);
    job.state = "attention";
    touch(job);
  });
  return job;
}

async function run(job: BundleJob, input: BundleInput, deps: BundleDeps) {
  const pollMs = deps.pollMs ?? 2000;
  const client = { id: input.client.id, workspaceId: input.client.workspaceId, name: input.client.name };
  const selected = selectedOf(job);
  const wantKeywords = selected.includes("keywords");
  const wantGap = selected.includes("gap");

  // 1. Competitors + keyword exports -- also when only the Gap report was picked (it's built from them).
  let fetched: Awaited<ReturnType<typeof fetchKeywords>> | null = null;
  if (wantKeywords || wantGap) {
    setPart(job, "keywords", { state: "running", step: wantKeywords ? "Starting" : "Fetching the keyword data for the Gap report" });
    try {
      fetched = await fetchKeywords(job, input, deps, pollMs);
    } catch (err) {
      const error = (err as Error).message.slice(0, 300);
      setPart(job, "keywords", wantKeywords ? { state: "failed", error } : { state: "skipped", step: "Not selected", error });
      if (wantGap) setPart(job, "gap", wantKeywords ? { state: "skipped", step: "Needs the keyword data" } : { state: "failed", error: `Needs the keyword data: ${error}` });
    }
  }

  // 2. Keyword report (+ gap) on the server, while the agent does 3 + 4.
  const audits = (["siteaudit", "woorank"] as const).filter((kind) => selected.includes(kind)).map((kind) => runAudit(job, kind, client, input.websiteUrl, deps, pollMs));
  const report = fetched ? buildKeywordReport(job, input, deps, fetched) : Promise.resolve(null);
  const [reportId] = await Promise.all([report, ...audits]);

  // 5. AI SEO Audit from THIS run's Site Audit and WooRank -- both (the user's choice, 2026-10-27). It used to
  // run from either, and quietly picked up an older audit for the one that failed.
  if (selected.includes("aiaudit")) {
    if (job.parts.siteaudit.state === "done" && job.parts.woorank.state === "done") {
      await runAudit(job, "aiaudit", client, input.websiteUrl, deps, pollMs, [job.auditIds.siteaudit!, job.auditIds.woorank!]);
    } else {
      const failed = (["siteaudit", "woorank"] as const).filter((k) => job.parts[k].state !== "done").map((k) => AUDIT_LABELS[k]);
      setPart(job, "aiaudit", { state: "skipped", step: `Needs this run's ${failed.join(" and ")} -- retry it in Audits, then run the AI SEO Audit there` });
    }
  }

  // Everything into one report -> one ClickUp comment.
  await finish(job, input, deps, reportId ?? null);
}

async function fetchKeywords(job: BundleJob, input: BundleInput, deps: BundleDeps, pollMs: number) {
  const client = { id: input.client.id, workspaceId: input.client.workspaceId };
  let competitors: string[] = input.competitors === "auto" ? [] : input.competitors.slice(0, COMPETITOR_COUNT);
  if (input.competitors === "auto") {
    if (!deps.competitorFetcher) {
      setPart(job, "keywords", { state: "running", step: "Finding competitors isn't available -- continuing without them" });
    } else {
      setPart(job, "keywords", { state: "running", step: "Finding competitors in Semrush" });
      const search = startCompetitorSearch({ client, websiteUrl: input.websiteUrl, location: input.location }, deps.competitorFetcher);
      const found = await until(() => getCompetitorSearch(search.id), (s) => s.state === "done" || s.state === "failed", pollMs);
      competitors = found.state === "done" ? (found.competitors ?? []).slice(0, COMPETITOR_COUNT).map((c) => c.domain) : [];
    }
  }
  job.competitors = competitors;
  if (!input.sources.includes("semrush") || !deps.fetchers.semrush) competitors = []; // competitors are compared on Semrush data

  const sourceJobs = [];
  for (const source of input.sources) {
    sourceJobs.push({ source, job: await startFetch({ source, client, websiteUrl: input.websiteUrl, location: input.location }, deps.fetchers) });
  }
  const competitorJobs = [];
  for (const domain of competitors) {
    competitorJobs.push({ domain, job: await startFetch({ source: "semrush", client, websiteUrl: domain, location: input.location }, deps.fetchers) });
  }
  const all = [...sourceJobs.map((s) => ({ label: SOURCE_LABELS[s.source], id: s.job.id })), ...competitorJobs.map((c) => ({ label: c.domain, id: c.job.id }))];
  const states = new Map<string, string>();
  for (const { label, id } of all) {
    const done = await until(() => getJob(id), (j) => j.state === "done" || j.state === "failed", pollMs, (j) => {
      states.set(id, j.state);
      const finished = [...states.values()].filter((s) => s === "done" || s === "failed").length;
      setPart(job, "keywords", { state: "running", step: `${label}: ${j.step ?? j.state} (${finished}/${all.length} exports)` });
    });
    states.set(id, done.state);
  }
  const okSources = sourceJobs.filter((s) => getJob(s.job.id)?.state === "done").map((s) => ({ source: s.source, id: s.job.id }));
  const okCompetitors = competitorJobs.filter((c) => getJob(c.job.id)?.state === "done").map((c) => ({ domain: c.domain, id: c.job.id }));
  if (okSources.length === 0) throw new Error("None of the keyword exports could be fetched.");
  // What's missing, with the tool's own reason -- kept on the finished row, not just while it runs
  // (2026-10-26: Ahrefs dropped out of a run and nobody could see it afterwards).
  const failed = [
    ...sourceJobs.filter((s) => getJob(s.job.id)?.state !== "done").map((s) => `${SOURCE_LABELS[s.source]} (${getJob(s.job.id)?.error ?? "failed"})`),
    ...competitorJobs.filter((c) => getJob(c.job.id)?.state !== "done").map((c) => `competitor ${c.domain} (${getJob(c.job.id)?.error ?? "failed"})`),
  ];
  const missing = failed.length ? `Without ${failed.join("; ")}` : undefined;
  setPart(job, "keywords", { state: "running", step: "Building the Keyword Analysis", error: missing });
  return { sources: okSources, competitors: okSources.some((s) => s.source === "semrush") ? okCompetitors : [], missing };
}

async function buildKeywordReport(job: BundleJob, input: BundleInput, deps: BundleDeps, fetched: NonNullable<Awaited<ReturnType<typeof fetchKeywords>>>): Promise<string | null> {
  const wantKeywords = selectedOf(job).includes("keywords");
  const wantGap = selectedOf(job).includes("gap");
  if (wantGap) {
    if (fetched.competitors.length > 0) setPart(job, "gap", { state: "running", step: "Waiting for the keyword data" });
    else setPart(job, "gap", { state: "skipped", step: "No competitors" });
  }
  try {
    const uploads: Partial<Record<KeywordSource, { buffer: Buffer; name: string }>> = {};
    for (const s of fetched.sources) uploads[s.source] = await fetchedExport(s.id, input.client.id, s.source);
    const competitors = [];
    for (const c of fetched.competitors) competitors.push(await fetchedCompetitorExport(c.id, input.client.id));
    const report = await createDomainReport(
      {
        client: { id: input.client.id, name: input.client.name },
        websiteUrl: input.websiteUrl,
        location: input.location,
        reportMode: input.reportMode,
        uploads,
        competitors,
        createdBy: input.createdBy,
        domainReportTaskId: input.client.domainReportTaskId,
      },
      deps.classifyWithAi,
      wantGap ? deps.gapAdvisor : null, // no Gemini call for a report nobody asked for
    );
    const names = (report.files as unknown as { name: string }[]).map((f) => f.name);
    const gap = names.find((n) => n.includes(GAP_FILE));
    setPart(
      job,
      "keywords",
      wantKeywords
        ? { state: "done", step: names.filter((n) => !n.includes(GAP_FILE)).join(", "), error: fetched.missing }
        : { state: "skipped", step: "Not selected -- its data was used for the Gap report", error: fetched.missing },
    );
    if (wantGap && fetched.competitors.length > 0) setPart(job, "gap", gap ? { state: "done", step: gap } : { state: "failed", error: "The gap report wasn't produced." });

    // Only the picked files stay in the report (and so in the comment).
    const kept = names.filter((n) => (n.includes(GAP_FILE) ? wantGap : wantKeywords));
    if (kept.length < names.length) await keepReportFiles(report.id, (n) => kept.includes(n));
    if (kept.length === 0) {
      // Nothing picked came out of it (e.g. the Gap report alone, without competitors) -- no empty history row.
      await prisma.domainReport.delete({ where: { id: report.id } });
      await rm(domainReportDir(report.id), { recursive: true, force: true }).catch(() => {});
      return null;
    }
    job.reportId = report.id;
    return report.id;
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    setPart(job, "keywords", wantKeywords ? { state: "failed", error } : { state: "skipped", step: "Not selected", error });
    if (job.parts.gap.state === "running") setPart(job, "gap", { state: "failed", error: wantKeywords ? "Needs the Keyword Analysis" : `Needs the keyword data: ${error}` });
    return null;
  }
}

/** One audit; a failure is retried once by itself (one-off glitches cleared on a retry, seen 2026-10-26). */
async function runAudit(
  job: BundleJob,
  kind: AuditKind,
  client: { id: string; workspaceId: string | null; name: string },
  websiteUrl: string,
  deps: BundleDeps,
  pollMs: number,
  sourceIds?: string[],
) {
  setPart(job, kind, { state: "running", step: "Queued" });
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const started = await startAudit({ kind, client, websiteUrl, sourceIds }, deps.auditFetchers, deps.aiAuditWriter);
      job.auditIds[kind] = started.id;
      const prefix = attempt > 1 ? "Retrying -- " : "";
      const done = await until(() => getAudit(started.id), (a) => a.state === "done" || a.state === "failed", pollMs, (a) =>
        setPart(job, kind, { state: "running", step: `${prefix}${a.step ?? "Working"}` }),
      );
      if (done.state === "done") {
        setPart(job, kind, { state: "done", step: done.fileName });
        return;
      }
      lastError = done.error ?? `${AUDIT_LABELS[kind]} failed.`;
    } catch (err) {
      lastError = (err as Error).message;
      if (err instanceof AuditJobError) break; // e.g. "not available on this server" -- a retry won't help
    }
    if (attempt === 1) setPart(job, kind, { state: "running", step: `First try failed (${lastError.slice(0, 120)}) -- trying once more` });
  }
  setPart(job, kind, { state: "failed", error: lastError.slice(0, 300) });
}

/**
 * After the run: an audit of this client finished AFTER the run started (the team retried a failed one
 * in the Audits section) counts for this run -- the panel shows it, and posting includes its file.
 */
export function syncBundle(job: BundleJob): BundleJob {
  if (job.state === "running") return job;
  const latest = latestAudits(job.clientId);
  let changed = false;
  for (const kind of AUDIT_PARTS) {
    const a = latest[kind];
    if (!selectedOf(job).includes(kind)) continue; // not picked for this run
    if (!a || a.createdAt < job.createdAt || a.id === job.auditIds[kind] || job.parts[kind].state === "done") continue;
    if (a.state === "done") {
      job.auditIds[kind] = a.id;
      job.parts[kind] = { state: "done", step: `${a.fileName} (run again in Audits)` };
      changed = true;
    } else if (a.state === "queued" || a.state === "running") {
      job.parts[kind] = { state: "running", step: `Running again in Audits -- ${a.step ?? "working"}` };
      changed = true;
    }
  }
  if (changed) {
    if (job.parts.post.state === "waiting" && isComplete(job))
      job.parts.post = { state: "waiting", step: `${selectedOf(job).length === 5 ? "All 5 reports are" : "The selected reports are"} ready -- post them to ClickUp` };
    touch(job);
  }
  return job;
}

/** Every PICKED report is done (a Gap report skipped for lack of competitors counts as done). */
const isComplete = (job: BundleJob) => selectedOf(job).every((p) => job.parts[p].state === "done" || (p === "gap" && job.parts.gap.state === "skipped"));

/** "Post to ClickUp" on a finished run: attach any audit files still missing (e.g. retried ones), then one comment. */
export async function postBundle(job: BundleJob, postComment: PostCommentFn): Promise<BundleJob> {
  syncBundle(job);
  if (job.state === "running") throw new BundleJobError("The run is still going -- wait for it to finish.");
  if (!job.reportId) {
    // An audits-only run whose audits all failed in the run, then succeeded when retried in the Audits section.
    const readyAudit = AUDIT_PARTS.some((k) => selectedOf(job).includes(k) && job.parts[k].state === "done");
    const client = readyAudit ? await prisma.client.findUnique({ where: { id: job.clientId }, select: { id: true, domainReportTaskId: true } }) : null;
    if (!client) throw new BundleJobError("There's nothing in this run to post -- run it again.");
    job.reportId = (await createAuditsOnlyReport({ client, websiteUrl: job.websiteUrl, createdBy: null, domainReportTaskId: client.domainReportTaskId })).id;
    touch(job);
  }
  // A second click (or a click after it worked) must never post the comment again (audit 2026-10-27).
  // The part is marked running before the first await, so two requests can't both get past this.
  if (job.parts.post.state === "running") throw new BundleJobError("Already posting -- wait for it to finish.");
  if (job.parts.post.state === "done") throw new BundleJobError("This run is already posted to ClickUp.");
  setPart(job, "post", { state: "running", step: "Posting one comment with every file" });
  try {
    const extra: { name: string; buffer: Buffer }[] = [];
    const adding: AuditKind[] = [];
    for (const kind of AUDIT_PARTS) {
      if (job.attachedAudits.includes(kind) || !selectedOf(job).includes(kind)) continue;
      const audit = job.auditIds[kind] ? getAudit(job.auditIds[kind]!) : undefined;
      if (audit?.state === "done" && audit.filePath) {
        extra.push({ name: `${job.clientName} - ${AUDIT_LABELS[kind]}${extOf(audit.fileName)}`, buffer: await readFile(audit.filePath) });
        adding.push(kind);
      }
    }
    if (extra.length) await attachFilesToReport(job.reportId, extra);
    job.attachedAudits.push(...adding); // only once they're really on the report
  } catch (err) {
    setPart(job, "post", { state: "failed", error: `Couldn't add the audit files: ${(err as Error).message}` });
    touch(job);
    throw err;
  }
  await postDomainReport(job.reportId, postComment);
  const report = await prisma.domainReport.findUnique({ where: { id: job.reportId } });
  setPart(job, "post", report?.status === "POSTED" ? { state: "done", step: "Posted to ClickUp" } : { state: "failed", error: report?.error ?? "Posting failed." });
  job.state = isComplete(job) && report?.status === "POSTED" ? "done" : "attention";
  touch(job);
  return job;
}

async function finish(job: BundleJob, input: BundleInput, deps: BundleDeps, reportId: string | null) {
  const auditIds = job.auditIds;
  const extra: { name: string; buffer: Buffer }[] = [];
  const attached: AuditKind[] = [];
  for (const kind of AUDIT_PARTS) {
    if (!selectedOf(job).includes(kind)) continue;
    const audit = auditIds[kind] ? getAudit(auditIds[kind]!) : undefined;
    if (audit?.state === "done" && audit.filePath) {
      extra.push({ name: `${input.client.name} - ${AUDIT_LABELS[kind]}${extOf(audit.fileName)}`, buffer: await readFile(audit.filePath) });
      attached.push(kind);
    }
  }
  // No keyword report (none picked, or it failed) but audits are ready: they get a report of their own,
  // so they can still be downloaded and posted (before 2026-10-27 that needed the Keyword Analysis).
  if (!reportId && extra.length > 0) {
    reportId = (await createAuditsOnlyReport({ client: input.client, websiteUrl: input.websiteUrl, createdBy: input.createdBy, domainReportTaskId: input.client.domainReportTaskId })).id;
    job.reportId = reportId;
  }
  if (!reportId) {
    setPart(job, "post", { state: "skipped", step: "Nothing to post -- none of the picked reports was made" });
    job.state = "attention";
    touch(job);
    return;
  }
  await attachFilesToReport(reportId, extra);
  job.attachedAudits = attached;
  const complete = isComplete(job);
  if (!input.client.domainReportTaskId) {
    setPart(job, "post", { state: "skipped", step: "No ClickUp task was given -- download the files below" });
  } else if (!complete) {
    setPart(job, "post", { state: "waiting", step: "Not posted: some reports are missing -- retry them, or post what's ready" });
    // Not "waiting to post" in the history (the page would keep checking): it's held until someone posts it.
    await prisma.domainReport.update({ where: { id: reportId }, data: { status: "NOT_POSTED", error: "Held back: some of the picked reports failed -- retry them, then post from Run all 5 reports." } });
  } else {
    setPart(job, "post", { state: "running", step: "Posting one comment with every file" });
    await postDomainReport(reportId, deps.postComment);
    const report = await prisma.domainReport.findUnique({ where: { id: reportId } });
    setPart(job, "post", report?.status === "POSTED" ? { state: "done", step: "Posted to ClickUp" } : { state: "failed", error: report?.error ?? "Posting failed." });
  }
  job.state = complete && job.parts.post.state !== "failed" ? "done" : "attention";
  touch(job);
}

const extOf = (name?: string) => (name?.toLowerCase().endsWith(".xlsx") ? ".xlsx" : ".pdf");

export function getBundle(id: string): BundleJob | undefined {
  return jobs.get(id);
}

/** The client's newest run -- so the page shows it again after a reload. */
export function latestBundle(clientId: string): BundleJob | undefined {
  return [...jobs.values()].filter((j) => j.clientId === clientId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

const RESUME_MS = 2 * 60 * 60 * 1000;

/**
 * The page has no client picker any more (2026-10-28): coming back to it shows the run this person started
 * in this workspace if it's still running, or finished in the last 2 hours needing a look (post / retry).
 */
export function myLatestBundle(workspaceId: string, createdBy: string): BundleJob | undefined {
  const cutoff = Date.now() - RESUME_MS;
  return [...jobs.values()]
    .filter((j) => j.workspaceId === workspaceId && j.createdBy === createdBy && (j.state === "running" || (j.state === "attention" && Date.parse(j.updatedAt) >= cutoff)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function publicBundle(job: BundleJob) {
  const { workspaceId: _ws, ...rest } = job;
  return { ...rest, websiteDomain: bareDomain(job.websiteUrl) };
}

/** Tests only. */
export function clearBundles() {
  jobs.clear();
}
