import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { findOwnedClientOrRespond } from "../../auth/ownership.js";
import { expensiveActionRateLimit } from "../rateLimit.js";
import { KeywordExportError } from "../../domainIntel/readKeywordExport.js";
import { LOCATIONS, REPORT_MODES, SOURCES, createDomainReport, postDomainReport, type ReportFile, type ReportMode } from "../../domainIntel/createDomainReport.js";
import type { PostCommentFn } from "../../domainIntel/clickupCommentPoster.js";
import type { ClassifyWithAiFn } from "../../domainIntel/classifyIntent.js";

// "Domain Intelligence" tab: a client's Semrush / Ubersuggest / Ahrefs keyword
// exports in -> intent-labelled Excel report(s) out, posted automatically as
// a comment on the client's domain-report ClickUp task (when one is set).

export interface DomainIntelRouterDeps {
  postComment: PostCommentFn;
  /** Override for tests; omitted = Claude when ANTHROPIC_API_KEY is set, else patterns only. */
  classifyWithAi?: ClassifyWithAiFn | null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 3 } });

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

      const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const uploads = Object.fromEntries(
        SOURCES.filter((s) => files[s]?.[0]).map((s) => [s, { buffer: files[s][0].buffer, name: files[s][0].originalname }]),
      );

      try {
        const report = await createDomainReport(
          {
            client: { id: client.id, name: client.name },
            websiteUrl,
            location: (LOCATIONS as readonly string[]).includes(body.location) ? body.location : null,
            reportMode,
            uploads,
            createdBy: req.authUser!.email,
            domainReportTaskId: client.domainReportTaskId,
          },
          deps.classifyWithAi,
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
