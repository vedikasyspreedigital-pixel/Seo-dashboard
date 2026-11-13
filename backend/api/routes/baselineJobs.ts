import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { expensiveActionRateLimit } from "../rateLimit.js";
import type { CallDataForSeoFn } from "../../worker/processRun.js";
import { callDataForSeoLive, hasDataForSeoCredentials, MISSING_CREDENTIALS_MESSAGE } from "../../dataforseo/client.js";
import { unwrapCall } from "../../dataforseo/gotoConverter.js";
import { hasSerperKey, serperSelected, MISSING_SERPER_KEY_MESSAGE } from "../../dataforseo/serperClient.js";
import { BaselineReportUnavailableError, saveKeywordMetrics } from "../../reporting/baselineReport.js";
import { KeywordPlannerFileError, readKeywordPlannerFile } from "../../reporting/keywordPlanner.js";
import {
  BaselineJobInputError,
  buildBaselineForJob,
  createBaselineJob,
  keywordsFromWorkbook,
  parseKeywordText,
  retryVolumes,
  viewBaselineJobs,
} from "../../reporting/baselineJobs.js";

// "Baseline Report" tab on Domain Intelligence (2026-11-13) -- see backend/reporting/baselineJobs.ts.
//   GET  /api/baseline-jobs?workspaceId=     this workspace's baseline jobs (newest first)
//   POST /api/baseline-jobs                  start one: client name, website, country + pasted keywords or an Excel
//   GET  /api/baseline-jobs/:id              one job (the page polls it while the keywords are checked)
//   GET  /api/baseline-jobs/:id/download     the Baseline Excel
//   POST /api/baseline-jobs/:id/volumes      fetch the Google Ads volumes again (after a failure)
//   POST /api/baseline-jobs/:id/keyword-planner   or upload the Keyword Planner download instead

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The same folder the runs page stores uploads in (backend/api/routes/runs.ts).
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(__dirname, "../../../uploads");
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function findOwnedJob(req: Request, res: Response) {
  const job = await prisma.baselineJob.findUnique({ where: { id: req.params.id as string } });
  if (!job || !req.authUser!.workspaceIds.includes(job.workspaceId)) {
    res.status(404).json({ error: "Baseline Report not found" });
    return null;
  }
  return job;
}

export function createBaselineJobsRouter(callDataForSeo: CallDataForSeoFn) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    if (!workspaceId || !req.authUser!.workspaceIds.includes(workspaceId)) {
      res.status(403).json({ error: "You do not have access to this workspace" });
      return;
    }
    res.json(await viewBaselineJobs({ workspaceId }));
  });

  router.post("/", expensiveActionRateLimit, upload.single("file"), async (req, res) => {
    const body = req.body ?? {};
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (!workspaceId || !req.authUser!.workspaceIds.includes(workspaceId)) {
      res.status(403).json({ error: "You do not have access to this workspace" });
      return;
    }
    // Same up-front refusal as starting a run: no rank checker set up means nothing would ever be checked.
    if (process.env.DATAFORSEO_LIVE === "true" && serperSelected() && !hasSerperKey()) {
      res.status(503).json({ error: MISSING_SERPER_KEY_MESSAGE });
      return;
    }
    if (unwrapCall(callDataForSeo) === callDataForSeoLive && !serperSelected() && !hasDataForSeoCredentials()) {
      res.status(503).json({ error: MISSING_CREDENTIALS_MESSAGE });
      return;
    }
    try {
      const fromFile = req.file ? await keywordsFromWorkbook(req.file.buffer) : [];
      const fromText = parseKeywordText(typeof body.keywords === "string" ? body.keywords : "");
      const seen = new Set<string>();
      const keywords = [...fromText, ...fromFile].filter((k) => !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()));
      const job = await createBaselineJob({
        workspaceId,
        clientName: typeof body.clientName === "string" ? body.clientName : "",
        websiteUrl: typeof body.websiteUrl === "string" ? body.websiteUrl : "",
        country: typeof body.country === "string" ? body.country : "",
        keywords,
        createdBy: req.authUser!.email,
        uploadsDir: UPLOADS_DIR,
        callDataForSeo,
      });
      const [view] = await viewBaselineJobs({ workspaceId, id: job.id }, 1);
      res.status(201).json(view);
    } catch (err) {
      if (err instanceof BaselineJobInputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/:id", async (req, res) => {
    const job = await findOwnedJob(req, res);
    if (!job) return;
    const [view] = await viewBaselineJobs({ workspaceId: job.workspaceId, id: job.id }, 1);
    res.json(view);
  });

  router.get("/:id/download", async (req, res) => {
    const job = await findOwnedJob(req, res);
    if (!job) return;
    const [view] = await viewBaselineJobs({ workspaceId: job.workspaceId, id: job.id }, 1);
    if (view.state === "checking") {
      res.status(409).json({ error: `Still checking the keywords (${view.done} of ${view.total}) -- try again when it's done.` });
      return;
    }
    try {
      const built = await buildBaselineForJob(job.id);
      res.setHeader("Content-Type", XLSX);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(built.filename)}`);
      res.send(built.buffer);
    } catch (err) {
      if (err instanceof BaselineReportUnavailableError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/:id/volumes", expensiveActionRateLimit, async (req, res) => {
    const job = await findOwnedJob(req, res);
    if (!job) return;
    await retryVolumes(job.id);
    const [view] = await viewBaselineJobs({ workspaceId: job.workspaceId, id: job.id }, 1);
    res.json(view);
  });

  router.post("/:id/keyword-planner", upload.single("file"), async (req, res) => {
    const job = await findOwnedJob(req, res);
    if (!job) return;
    if (!req.file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    let metrics;
    try {
      metrics = await readKeywordPlannerFile(req.file.buffer, req.file.originalname);
    } catch (err) {
      if (err instanceof KeywordPlannerFileError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
    await saveKeywordMetrics(job.clientId, metrics, "upload", req.authUser!.email);
    await prisma.baselineJob.update({ where: { id: job.id }, data: { volumesFetchedAt: new Date(), volumesError: null } });
    const [view] = await viewBaselineJobs({ workspaceId: job.workspaceId, id: job.id }, 1);
    res.json(view);
  });

  return router;
}
