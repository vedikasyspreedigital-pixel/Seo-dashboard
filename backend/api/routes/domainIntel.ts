import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { findOwnedClientOrRespond } from "../../auth/ownership.js";
import { expensiveActionRateLimit } from "../rateLimit.js";
import { KeywordExportError, type KeywordSource } from "../../domainIntel/readKeywordExport.js";
import { LOCATIONS, REPORT_MODES, SOURCES, createDomainReport, postDomainReport, type ReportFile, type ReportMode } from "../../domainIntel/createDomainReport.js";
import type { PostCommentFn } from "../../domainIntel/clickupCommentPoster.js";
import type { ClassifyWithAiFn } from "../../domainIntel/classifyIntent.js";
import type { FetchExportFn } from "../../domainIntel/fetchers/flikoverAhrefs.js";
import { FetchJobError, fetchedCompetitorExport, fetchedExport, getJob, latestLoginProblem, publicJob, startFetch } from "../../domainIntel/fetchJob.js";
import {
  COMPETITOR_COUNT,
  CompetitorJobError,
  getCompetitorSearch,
  publicCompetitorSearch,
  startCompetitorSearch,
} from "../../domainIntel/competitorJob.js";
import type { AiAuditWriter } from "../../domainIntel/aiSeoAudit.js";
import type { GapAdvisor } from "../../domainIntel/gapReport.js";
import { AUDIT_KINDS, AuditJobError, auditFile, getAudit, publicAudit, startAudit, type AuditKind } from "../../domainIntel/auditJob.js";

// "Domain Intelligence" tab: a client's Semrush / Ubersuggest / Ahrefs keyword
// exports in -> intent-labelled Excel report(s) out, posted automatically as
// a comment on the client's domain-report ClickUp task (when one is set).
// Ahrefs can also be FETCHED (POST /fetches) while the other files are being
// uploaded; "Combine and post" then passes the finished fetch's id instead of
// a file (fetched_<source>).

export interface DomainIntelRouterDeps {
  postComment: PostCommentFn;
  /** Override for tests; omitted = Claude when ANTHROPIC_API_KEY is set, else patterns only. */
  classifyWithAi?: ClassifyWithAiFn | null;
  /** Tools that can be fetched automatically -- today only Ahrefs via Flikover. */
  fetchers?: Partial<Record<KeywordSource, FetchExportFn>>;
  /** Report PDFs the office Chrome agent makes (Semrush Site Audit, WooRank). */
  auditFetchers?: Partial<Record<AuditKind, FetchExportFn>>;
  /** Gemini's recommendations for the Gap & Competitor Analysis; omitted/null = gap data only. */
  gapAdvisor?: GapAdvisor | null;
  /** Semrush's "Main Organic Competitors" through the office Chrome agent (agent mode only). */
  competitorFetcher?: FetchExportFn;
  /** The AI SEO Audit (Gemini reading the finished report PDFs); null when no GEMINI_API_KEY. */
  aiAuditWriter?: AiAuditWriter | null;
  /** For the page: is fetching live or mock, and is a login saved? */
  fetchInfo?: () => Promise<{
    live: boolean;
    sessionSaved: boolean;
    mode?: string;
    /** "agent" mode: is the office Chrome extension polling? */
    agent?: { online: boolean; lastSeenAt: number | null; version: string | null } | null;
  }>;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 3 } });

const isSource = (s: unknown): s is KeywordSource => typeof s === "string" && (SOURCES as string[]).includes(s);

// A post still marked POSTING after this long was cut off (restart/crash) -- allow retrying it.
const STALE_POSTING_MS = 10 * 60 * 1000;

type DomainReportRow = Awaited<ReturnType<typeof prisma.domainReport.findFirstOrThrow>>;

/** Never sends server file paths to the browser. */
function toResponse(report: DomainReportRow) {
  const { files, ...rest } = report;
  return { ...rest, files: (files as unknown as ReportFile[]).map((f) => ({ name: f.name })) };
}

async function findOwnedReportOrRespond(req: Request, res: Response, id: string) {
  const report = await prisma.domainReport.findUnique({ where: { id }, include: { client: { select: { workspaceId: true } } } });
  if (!report || !report.client.workspaceId || !req.authUser!.workspaceIds.includes(report.client.workspaceId)) {
    res.status(404).json({ error: "Report not found" });
    return null;
  }
  return report;
}

export function createDomainIntelRouter(deps: DomainIntelRouterDeps) {
  const router = Router();
  router.use(requireAuth);
  const fetchers = deps.fetchers ?? {};

  // Which tools can be fetched automatically, and whether a person needs to sign in to Flikover again.
  router.get("/fetch-status", async (req, res) => {
    const info = deps.fetchInfo ? await deps.fetchInfo() : { live: false, sessionSaved: false };
    res.json({
      automatic: Object.keys(fetchers),
      live: info.live,
      mode: info.mode ?? (info.live ? "playwright" : "mock"),
      sessionSaved: info.sessionSaved,
      agentOnline: info.agent ? info.agent.online : null,
      agentLastSeenAt: info.agent?.lastSeenAt ?? null,
      loginProblem: latestLoginProblem(req.authUser!.workspaceIds),
    });
  });

  // "Fetch from Ahrefs": starts in the background, returns the job at once; the page polls GET /fetches/:id.
  router.post("/fetches", expensiveActionRateLimit, async (req, res) => {
    const body = req.body ?? {};
    if (!isSource(body.source)) {
      res.status(400).json({ error: "Unknown tool." });
      return;
    }
    if (typeof body.clientId !== "string" || !body.clientId) {
      res.status(400).json({ error: "Pick a client." });
      return;
    }
    const client = await findOwnedClientOrRespond(req, res, body.clientId, { requireActive: true });
    if (!client) return;
    const websiteUrl = (typeof body.websiteUrl === "string" ? body.websiteUrl.trim().slice(0, 300) : "") || client.domain || "";
    if (!websiteUrl) {
      res.status(400).json({ error: "Enter the client's website URL." });
      return;
    }
    try {
      const job = await startFetch(
        {
          source: body.source,
          client: { id: client.id, workspaceId: client.workspaceId },
          websiteUrl,
          location: (LOCATIONS as readonly string[]).includes(body.location) ? body.location : null,
        },
        fetchers,
      );
      res.status(202).json(publicJob(job));
    } catch (err) {
      if (err instanceof FetchJobError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Report PDFs (Semrush Site Audit, later WooRank): queued for the office Chrome agent; can take many minutes.
  router.post("/audits", expensiveActionRateLimit, async (req, res) => {
    const body = req.body ?? {};
    if (!(AUDIT_KINDS as string[]).includes(body.kind)) {
      res.status(400).json({ error: "Unknown report." });
      return;
    }
    if (typeof body.clientId !== "string" || !body.clientId) {
      res.status(400).json({ error: "Pick a client." });
      return;
    }
    const client = await findOwnedClientOrRespond(req, res, body.clientId, { requireActive: true });
    if (!client) return;
    const websiteUrl = (typeof body.websiteUrl === "string" ? body.websiteUrl.trim().slice(0, 300) : "") || client.domain || "";
    if (!websiteUrl) {
      res.status(400).json({ error: "Enter the client's website URL." });
      return;
    }
    try {
      const job = await startAudit(
        { kind: body.kind, client: { id: client.id, workspaceId: client.workspaceId, name: client.name }, websiteUrl },
        deps.auditFetchers ?? {},
        deps.aiAuditWriter,
      );
      res.status(202).json(publicAudit(job));
    } catch (err) {
      if (err instanceof AuditJobError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // "Find competitors": Semrush's Main Organic Competitors for the client's site, through the agent.
  router.post("/competitors", expensiveActionRateLimit, async (req, res) => {
    const body = req.body ?? {};
    if (typeof body.clientId !== "string" || !body.clientId) {
      res.status(400).json({ error: "Pick a client." });
      return;
    }
    const client = await findOwnedClientOrRespond(req, res, body.clientId, { requireActive: true });
    if (!client) return;
    const websiteUrl = (typeof body.websiteUrl === "string" ? body.websiteUrl.trim().slice(0, 300) : "") || client.domain || "";
    if (!websiteUrl) {
      res.status(400).json({ error: "Enter the client's website URL." });
      return;
    }
    try {
      const job = startCompetitorSearch(
        {
          client: { id: client.id, workspaceId: client.workspaceId },
          websiteUrl,
          location: (LOCATIONS as readonly string[]).includes(body.location) ? body.location : null,
        },
        deps.competitorFetcher,
      );
      res.status(202).json(publicCompetitorSearch(job));
    } catch (err) {
      if (err instanceof CompetitorJobError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/competitors/:id", (req, res) => {
    const job = getCompetitorSearch(req.params.id as string);
    if (!job || !job.workspaceId || !req.authUser!.workspaceIds.includes(job.workspaceId)) {
      res.status(404).json({ error: "This competitor search is no longer available -- run it again." });
      return;
    }
    res.json(publicCompetitorSearch(job));
  });

  const ownedAudit = (req: Request, res: Response) => {
    const job = getAudit(req.params.id as string);
    if (!job || !job.workspaceId || !req.authUser!.workspaceIds.includes(job.workspaceId)) {
      res.status(404).json({ error: "This report is no longer available -- run it again." });
      return null;
    }
    return job;
  };

  router.get("/audits/:id", (req, res) => {
    const job = ownedAudit(req, res);
    if (job) res.json(publicAudit(job));
  });

  router.get("/audits/:id/file", async (req, res) => {
    const job = ownedAudit(req, res);
    if (!job) return;
    const file = await auditFile(job.id);
    if (!file) {
      res.status(409).json({ error: "The report isn't ready yet." });
      return;
    }
    res.setHeader("Content-Type", file.name.toLowerCase().endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name.replace(/"/g, "")}"`);
    res.send(file.buffer);
  });

  router.get("/fetches/:id", async (req, res) => {
    const job = getJob(req.params.id as string);
    if (!job || !job.workspaceId || !req.authUser!.workspaceIds.includes(job.workspaceId)) {
      res.status(404).json({ error: "This fetch is no longer available -- fetch again." });
      return;
    }
    res.json(publicJob(job));
  });

  router.post(
    "/reports",
    expensiveActionRateLimit,
    upload.fields(SOURCES.map((name) => ({ name, maxCount: 1 }))),
    async (req, res) => {
      const body = req.body ?? {};
      if (typeof body.clientId !== "string" || !body.clientId) {
        res.status(400).json({ error: "Pick a client." });
        return;
      }
      const client = await findOwnedClientOrRespond(req, res, body.clientId, { requireActive: true });
      if (!client) return;
      const reportMode = (REPORT_MODES as string[]).includes(body.reportMode) ? (body.reportMode as ReportMode) : "combined";
      const websiteUrl = (typeof body.websiteUrl === "string" ? body.websiteUrl.trim().slice(0, 300) : "") || client.domain || "";
      if (!websiteUrl) {
        res.status(400).json({ error: "Enter the client's website URL." });
        return;
      }

      try {
        // An uploaded file, or a finished fetch's id (fetched_<source>) -- the upload wins if both are sent.
        const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        const uploads: Partial<Record<KeywordSource, { buffer: Buffer; name: string }>> = {};
        for (const s of SOURCES) {
          const file = files[s]?.[0];
          const fetchId = body[`fetched_${s}`];
          if (file) uploads[s] = { buffer: file.buffer, name: file.originalname };
          else if (typeof fetchId === "string" && fetchId) uploads[s] = await fetchedExport(fetchId, client.id, s);
        }
        // Competitors' Semrush fetches: "competitor_fetches" = their fetch ids, comma-separated (max 3).
        const competitorIds = typeof body.competitor_fetches === "string" ? body.competitor_fetches.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
        if (competitorIds.length > COMPETITOR_COUNT) {
          res.status(400).json({ error: `At most ${COMPETITOR_COUNT} competitors.` });
          return;
        }
        const competitors = [];
        for (const id of competitorIds) competitors.push(await fetchedCompetitorExport(id, client.id));
        const report = await createDomainReport(
          {
            client: { id: client.id, name: client.name },
            websiteUrl,
            location: (LOCATIONS as readonly string[]).includes(body.location) ? body.location : null,
            reportMode,
            uploads,
            competitors,
            createdBy: req.authUser!.email,
            domainReportTaskId: client.domainReportTaskId,
          },
          deps.classifyWithAi,
          deps.gapAdvisor,
        );
        // Posting runs in the background (a real ClickUp post takes ~30-60s); the page polls the report's status.
        if (report.status === "GENERATED") void postDomainReport(report.id, deps.postComment);
        res.status(201).json(toResponse(report));
      } catch (err) {
        if (err instanceof KeywordExportError) {
          res.status(422).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.get("/reports", async (req, res) => {
    const clientId = req.query.clientId;
    if (typeof clientId !== "string" || !clientId) {
      res.status(400).json({ error: "clientId query parameter is required" });
      return;
    }
    const client = await findOwnedClientOrRespond(req, res, clientId);
    if (!client) return;
    const reports = await prisma.domainReport.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 20 });
    res.json(reports.map(toResponse));
  });

  router.get("/reports/:id", async (req, res) => {
    const report = await findOwnedReportOrRespond(req, res, req.params.id as string);
    if (!report) return;
    const { client: _client, ...rest } = report;
    res.json(toResponse(rest));
  });

  router.get("/reports/:id/files/:index", async (req, res) => {
    const report = await findOwnedReportOrRespond(req, res, req.params.id as string);
    if (!report) return;
    const file = (report.files as unknown as ReportFile[])[Number(req.params.index)];
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.download(path.resolve(file.path), file.name);
  });

  router.post("/reports/:id/post", expensiveActionRateLimit, async (req, res) => {
    const report = await findOwnedReportOrRespond(req, res, req.params.id as string);
    if (!report) return;
    const stalePosting = report.status === "POSTING" && Date.now() - report.createdAt.getTime() > STALE_POSTING_MS;
    if (report.status === "POSTED" || (report.status === "POSTING" && !stalePosting) || report.status === "GENERATING") {
      res.status(409).json({ error: report.status === "POSTED" ? "This report is already posted." : "This report is still being processed." });
      return;
    }
    void postDomainReport(report.id, deps.postComment);
    res.status(202).json({ ok: true });
  });

  return router;
}
