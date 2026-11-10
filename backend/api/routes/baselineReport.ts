import { Router } from "express";
import multer from "multer";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { findOwnedReportOrRespond } from "../../auth/ownership.js";
import { BaselineReportUnavailableError, buildBaselineForReport, saveKeywordMetrics } from "../../reporting/baselineReport.js";
import { GoogleAdsError, KeywordPlannerFileError, countryOfSeDomain, fetchGoogleAdsMetrics, googleAdsConfigured, readKeywordPlannerFile } from "../../reporting/keywordPlanner.js";

// "Baseline Report" (2026-11-10) -- see backend/reporting/baselineReport.ts.
//   GET  /api/reports/:id/baseline-report/info          what it would contain, what's still missing
//   GET  /api/reports/:id/baseline-report               the Excel itself (download to check)
//   POST /api/reports/:id/baseline-report/keyword-planner  the team's Keyword Planner download (.csv/.xlsx)
//   POST /api/reports/:id/baseline-report/google-ads    fetch the same numbers from the Google Ads API (once set up)

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const baselineReportRouter = Router();
baselineReportRouter.use(requireAuth);

async function info(reportId: string) {
  const built = await buildBaselineForReport(reportId);
  const { buffer: _buffer, ...rest } = built;
  return { ready: true, ...rest };
}

baselineReportRouter.get("/:id/baseline-report/info", async (req, res) => {
  const report = await findOwnedReportOrRespond(req, res, req.params.id as string);
  if (!report) return;
  try {
    res.json(await info(report.id));
  } catch (err) {
    if (err instanceof BaselineReportUnavailableError) {
      res.json({ ready: false, error: err.message, googleAdsAvailable: googleAdsConfigured() });
      return;
    }
    throw err;
  }
});

baselineReportRouter.get("/:id/baseline-report", async (req, res) => {
  const report = await findOwnedReportOrRespond(req, res, req.params.id as string);
  if (!report) return;
  try {
    const built = await buildBaselineForReport(report.id);
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

/** The team's Keyword Planner download for this client's keywords -- kept per client, newest numbers win. */
baselineReportRouter.post("/:id/baseline-report/keyword-planner", upload.single("file"), async (req, res) => {
  const report = await findOwnedReportOrRespond(req, res, req.params.id as string, { requireActive: true });
  if (!report) return;
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
  const saved = await saveKeywordMetrics(report.clientId, metrics, "upload", req.authUser!.email);
  res.json({ saved, ...(await info(report.id)) });
});

/** Volume/competition straight from the Google Ads API (free) -- only once the GOOGLE_ADS_* variables are set. */
baselineReportRouter.post("/:id/baseline-report/google-ads", async (req, res) => {
  const report = await findOwnedReportOrRespond(req, res, req.params.id as string, { requireActive: true });
  if (!report) return;
  if (!googleAdsConfigured()) {
    res.status(503).json({ error: "The Google Ads API isn't set up on the server yet -- upload the Keyword Planner download instead." });
    return;
  }
  const rows = await prisma.rankingRow.findMany({ where: { runId: report.runId }, select: { keyword: true, seDomain: true } });
  const country = countryOfSeDomain(rows[0]?.seDomain);
  if (!country) {
    res.status(422).json({ error: `Couldn't tell the client's country from the search domain "${rows[0]?.seDomain ?? ""}" -- upload the Keyword Planner download instead.` });
    return;
  }
  try {
    const metrics = await fetchGoogleAdsMetrics(
      rows.map((r) => r.keyword),
      country,
    );
    const saved = await saveKeywordMetrics(report.clientId, metrics, "google_ads", req.authUser!.email);
    res.json({ saved, ...(await info(report.id)) });
  } catch (err) {
    if (err instanceof GoogleAdsError) {
      res.status(502).json({ error: err.message });
      return;
    }
    throw err;
  }
});
