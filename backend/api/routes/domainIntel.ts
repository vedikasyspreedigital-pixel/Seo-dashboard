import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { findOwnedClientOrRespond } from "../../auth/ownership.js";
import { expensiveActionRateLimit } from "../rateLimit.js";
import { KeywordExportError, type KeywordSource } from "../../domainIntel/readKeywordExport.js";
import { LOCATIONS, REPORT_MODES, SOURCES, createDomainReport, isPostingNow, postDomainReport, type ReportFile, type ReportMode } from "../../domainIntel/createDomainReport.js";
import type { PostCommentFn } from "../../domainIntel/clickupCommentPoster.js";
import type { ClassifyWithAiFn } from "../../domainIntel/classifyIntent.js";
import { bareDomain, type FetchExportFn } from "../../domainIntel/fetchers/flikoverAhrefs.js";
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
import { AUDIT_KINDS, AuditJobError, auditFile, getAudit, latestAudits, publicAudit, startAudit, type AuditKind } from "../../domainIntel/auditJob.js";
import { BUNDLE_REPORTS, BundleJobError, getBundle, latestBundle, myLatestBundle, postBundle, publicBundle, startBundle, syncBundle } from "../../domainIntel/bundleJob.js";
import { ProspectClientError, findOrCreateProspectClient } from "../../domainIntel/prospectClient.js";

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
  /** Tests only: how often a "Run all 5 reports" checks on its parts (default 2s). */
  bundlePollMs?: number;
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


type DomainReportRow = Awaited<ReturnType<typeof prisma.domainReport.findFirstOrThrow>>;

/** Never sends server file paths to the browser. */
function toResponse(report: DomainReportRow) {
  const { files, ...rest } = report;
  return { ...rest, files: (files as unknown as ReportFile[]).map((f) => ({ name: f.name })) };
}

const HISTORY_LIMIT = 100;

/** The ?workspaceId= the caller is a member of, else answers 400/403 and returns null. */
function ownedWorkspaceOrRespond(req: Request, res: Response): string | null {
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
  if (!workspaceId) {
    res.status(400).json({ error: "workspaceId query parameter is required" });
    return null;
  }
  if (!req.authUser!.workspaceIds.includes(workspaceId)) {
    res.status(403).json({ error: "You do not have access to this workspace" });
    return null;
  }
  return workspaceId;
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

  // The client's newest Site Audit / WooRank / AI audit (any state) -- the page's audit cards.
  router.get("/audits", async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
    const client = clientId ? await findOwnedClientOrRespond(req, res, clientId) : null;
    if (!client) {
      if (!res.headersSent) res.status(400).json({ error: "Pick a client." });
      return;
    }
    const latest = latestAudits(client.id);
    res.json(Object.fromEntries(Object.entries(latest).map(([kind, job]) => [kind, publicAudit(job!)])));
  });

  // "Run all 5 reports": keywords (+ competitors, gap), Site Audit, WooRank, AI audit, then one ClickUp comment.
  router.post("/bundles", expensiveActionRateLimit, async (req, res) => {
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
    const sources = Array.isArray(body.sources) ? (body.sources as unknown[]).filter(isSource) : [];
    const reports = Array.isArray(body.reports) ? BUNDLE_REPORTS.filter((r) => (body.reports as unknown[]).includes(r)) : undefined;
    // Keyword tools only matter for the Keyword Analysis and the Gap report -- an audits-only run needs none.
    if (sources.length === 0 && (!reports || reports.includes("keywords") || reports.includes("gap"))) {
      res.status(400).json({ error: "Pick at least one keyword tool." });
      return;
    }
    const competitors =
      body.competitors === "auto"
        ? ("auto" as const)
        : Array.isArray(body.competitors)
          ? [...new Set((body.competitors as unknown[]).filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => bareDomain(c.slice(0, 200))))]
              .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d !== bareDomain(websiteUrl))
              .slice(0, COMPETITOR_COUNT)
          : [];
    try {
      const job = startBundle(
        {
          client: { id: client.id, workspaceId: client.workspaceId, name: client.name, domainReportTaskId: client.domainReportTaskId },
          websiteUrl,
          location: (LOCATIONS as readonly string[]).includes(body.location) ? body.location : null,
          sources,
          competitors,
          reportMode: (REPORT_MODES as string[]).includes(body.reportMode) ? (body.reportMode as ReportMode) : "combined",
          createdBy: req.authUser!.email,
          // The reports the team ticked; omitted = all 5 (unknown names are ignored).
          ...(reports ? { reports } : {}),
        },
        {
          fetchers,
          competitorFetcher: deps.competitorFetcher,
          auditFetchers: deps.auditFetchers ?? {},
          aiAuditWriter: deps.aiAuditWriter,
          classifyWithAi: deps.classifyWithAi,
          gapAdvisor: deps.gapAdvisor,
          postComment: deps.postComment,
          pollMs: deps.bundlePollMs,
        },
      );
      res.status(202).json(publicBundle(job));
    } catch (err) {
      if (err instanceof BundleJobError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // The client's newest run (any state) -- the page shows its progress again after a reload.
  router.get("/bundles", async (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
    const client = clientId ? await findOwnedClientOrRespond(req, res, clientId) : null;
    if (!client) {
      if (!res.headersSent) res.status(400).json({ error: "Pick a client." });
      return;
    }
    const job = latestBundle(client.id);
    res.json(job ? publicBundle(syncBundle(job)) : null);
  });

  // This person's run in this workspace that's still going (or just finished) -- the page shows it again.
  router.get("/bundles/mine", (req, res) => {
    const workspaceId = ownedWorkspaceOrRespond(req, res);
    if (!workspaceId) return;
    const job = myLatestBundle(workspaceId, req.authUser!.email);
    res.json(job ? publicBundle(syncBundle(job)) : null);
  });

  const ownedBundle = (req: Request, res: Response) => {
    const job = getBundle(req.params.id as string);
    if (!job || !job.workspaceId || !req.authUser!.workspaceIds.includes(job.workspaceId)) {
      res.status(404).json({ error: "This run is no longer available -- start it again." });
      return null;
    }
    return job;
  };

  router.get("/bundles/:id", (req, res) => {
    const job = ownedBundle(req, res);
    if (job) res.json(publicBundle(syncBundle(job)));
  });

  // Post a finished run: adds any audit retried since (Audits section), then one ClickUp comment.
  router.post("/bundles/:id/post", expensiveActionRateLimit, async (req, res) => {
    const job = ownedBundle(req, res);
    if (!job) return;
    try {
      res.json(publicBundle(await postBundle(job, deps.postComment)));
    } catch (err) {
      if (err instanceof BundleJobError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

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
    res.attachment(file.name); // encodes any name (a "–" or non-English letters used to make this a 500)
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

  // Every Domain Intelligence report in the workspace, newest first, with its client's name (the page's history).
  router.get("/history", async (req, res) => {
    const workspaceId = ownedWorkspaceOrRespond(req, res);
    if (!workspaceId) return;
    const reports = await prisma.domainReport.findMany({
      where: { client: { workspaceId } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      include: { client: { select: { name: true, domainReportTaskId: true } } },
    });
    res.json(reports.map(({ client, ...r }) => ({ ...toResponse(r), clientName: client.name, clientTaskId: client.domainReportTaskId })));
  });

  // The page's typed client name -> a (hidden) Domain Intelligence client, made once per name and reused after.
  router.post("/clients", async (req, res) => {
    const body = req.body ?? {};
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (!workspaceId || !req.authUser!.workspaceIds.includes(workspaceId)) {
      res.status(403).json({ error: "You do not have access to this workspace" });
      return;
    }
    try {
      const client = await findOrCreateProspectClient({
        workspaceId,
        name: typeof body.name === "string" ? body.name : "",
        websiteUrl: typeof body.websiteUrl === "string" ? body.websiteUrl : "",
        clickupTask: typeof body.clickupTask === "string" ? body.clickupTask : "",
      });
      res.json(client);
    } catch (err) {
      if (err instanceof ProspectClientError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
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
    // POSTING but not being posted by this server = cut off by a restart: retryable (the poster's marker check
    // still stops a second comment if the first one did land).
    const stalePosting = report.status === "POSTING" && !isPostingNow(report.id);
    if (report.status === "POSTED" || (report.status === "POSTING" && !stalePosting) || report.status === "GENERATING") {
      res.status(409).json({ error: report.status === "POSTED" ? "This report is already posted." : "This report is still being processed." });
      return;
    }
    void postDomainReport(report.id, deps.postComment);
    res.status(202).json({ ok: true });
  });

  return router;
}
