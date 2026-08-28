import { Router } from "express";
import { prisma } from "../../db/client.js";
import { rejectReport } from "../../reporting/reportTransitions.js";
import { updateReportDraft } from "../../reporting/editReportDraft.js";
import { approveAndSendReport } from "../../reporting/approveAndSend.js";
import { generateEmailDraft, regenerateEmailDraft } from "../../reporting/generateEmailDraft.js";
import { createReportForRun } from "../../reporting/createReport.js";
import { generateInsights } from "../../reporting/generateInsights.js";
import { buildReport } from "../../reporting/buildReport.js";
import { InvalidReportTransitionError } from "../../reporting/errors.js";
import type { CallClaudeEmailDraftFn } from "../../reporting/emailDraft.js";
import type { CallClaudeFn } from "../../reporting/reportAnalyst.js";
import type { SendEmailFn } from "../../reporting/emailSender.js";
import type { GenerateExcelAttachmentFn } from "../../reporting/generateExcelAttachment.js";

export interface ReportsRouterDeps {
  callClaudeAnalyst: CallClaudeFn;
  callClaudeEmailDraft: CallClaudeEmailDraftFn;
  sendEmail: SendEmailFn;
  /** Optional: omit to send without the Excel-as-PDF attachment (e.g. in tests). */
  generateExcelAttachment?: GenerateExcelAttachmentFn;
}

export function createReportsRouter({ callClaudeAnalyst, callClaudeEmailDraft, sendEmail, generateExcelAttachment }: ReportsRouterDeps) {
  const router = Router();

  // Create: turns a completed RankingRun into a RankingReport, eagerly
  // computing analytics (pure backend code, no Claude) so the wizard's
  // Analytics Preview step has data to show. Does NOT call Claude -- that's
  // the separate /generate-insights step below.
  router.post("/", async (req, res) => {
    const runId = req.body?.runId;
    const previousRunId = req.body?.previousRunId;
    if (typeof runId !== "string" || runId.length === 0) {
      res.status(400).json({ error: "runId is required" });
      return;
    }
    if (previousRunId !== undefined && typeof previousRunId !== "string") {
      res.status(400).json({ error: "previousRunId must be a string when provided" });
      return;
    }

    const result = await createReportForRun(runId, previousRunId);
    switch (result.outcome) {
      case "RUN_NOT_FOUND":
        res.status(404).json({ error: "Run not found" });
        return;
      case "RUN_NOT_COMPLETED":
        res.status(409).json({ error: `Run is not completed (status: ${result.runStatus})` });
        return;
      case "DUPLICATE_REPORT":
        res.status(409).json({ error: "A report already exists for this run", existingReportId: result.existingReportId });
        return;
      case "SUCCESS":
        res.status(201).json({ report: result.report });
        return;
    }
  });

  // List: reports for a client, most recent first -- backs the Reports nav page.
  router.get("/", async (req, res) => {
    const clientId = req.query.clientId;
    if (typeof clientId !== "string" || clientId.length === 0) {
      res.status(400).json({ error: "clientId query parameter is required" });
      return;
    }
    const reports = await prisma.rankingReport.findMany({
      where: { clientId },
      include: { run: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(reports);
  });

  // The "Generate Insights with Claude" wizard step: PENDING_ANALYSIS ->
  // ANALYSIS_READY, via the injected (mock, in this app) Claude client.
  router.post("/:id/generate-insights", async (req, res) => {
    try {
      const result = await generateInsights(req.params.id, callClaudeAnalyst);
      res.json(result);
    } catch (err) {
      if (err instanceof InvalidReportTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // The "Build Report" wizard step: ANALYSIS_READY -> REPORT_READY.
  // Deterministic -- no Claude call.
  router.post("/:id/build-report", async (req, res) => {
    try {
      const result = await buildReport(req.params.id);
      res.json(result);
    } catch (err) {
      if (err instanceof InvalidReportTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Preview: the full report -- analytics, analysis, rendered HTML, and
  // the current email draft/recipients/status, all in one place.
  router.get("/:id", async (req, res) => {
    const report = await prisma.rankingReport.findUnique({
      where: { id: req.params.id },
      include: { client: true, run: true, previousRun: true },
    });
    if (!report) {
      res.status(404).json({ error: "Report not found" });
      return;
    }
    res.json(report);
  });

  // Edit recipients/subject/body -- only while the report is sitting in
  // the approval queue (PENDING_APPROVAL). Human editing, never Claude.
  router.patch("/:id", async (req, res) => {
    const { emailSubject, emailBody, emailBodyHtml, resolvedRecipients, resolvedClickupTaskUrl } = req.body ?? {};
    if (resolvedRecipients !== undefined && !Array.isArray(resolvedRecipients)) {
      res.status(400).json({ error: "resolvedRecipients must be an array of email addresses" });
      return;
    }
    if (resolvedClickupTaskUrl !== undefined && resolvedClickupTaskUrl !== null && typeof resolvedClickupTaskUrl !== "string") {
      res.status(400).json({ error: "resolvedClickupTaskUrl must be a string or null" });
      return;
    }
    try {
      const updated = await updateReportDraft(req.params.id, { emailSubject, emailBody, emailBodyHtml, resolvedRecipients, resolvedClickupTaskUrl });
      res.json(updated);
    } catch (err) {
      if (err instanceof InvalidReportTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // The one action that can actually send an email. Recipients are read
  // from what was already resolved from ClientReportConfig at draft time --
  // this endpoint never accepts a recipient list from the request body.
  router.post("/:id/approve-and-send", async (req, res) => {
    const approvedBy = req.body?.approvedBy;
    if (typeof approvedBy !== "string" || approvedBy.length === 0) {
      res.status(400).json({ error: "approvedBy is required" });
      return;
    }
    const result = await approveAndSendReport(req.params.id, { approvedBy, sendEmail, generateExcelAttachment });
    const statusCode = result.outcome === "SENT" ? 200 : result.outcome === "ALREADY_PROCESSED" ? 409 : result.outcome === "NO_RECIPIENTS" ? 422 : 502;
    res.status(statusCode).json(result);
  });

  router.post("/:id/reject", async (req, res) => {
    try {
      const rejected = await rejectReport(req.params.id);
      res.json(rejected);
    } catch (err) {
      if (err instanceof InvalidReportTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // The missing link between report creation (which stops at REPORT_READY)
  // and the approval queue: drives the existing, unmodified generateEmailDraft
  // service (REPORT_READY -> EMAIL_DRAFTED -> PENDING_APPROVAL). Was never
  // exposed via the router before -- only its sibling regenerateEmailDraft
  // (PENDING_APPROVAL -> ... -> PENDING_APPROVAL) was, which cannot run this
  // first draft since it requires PENDING_APPROVAL as its starting state.
  router.post("/:id/generate-email-draft", async (req, res) => {
    try {
      const result = await generateEmailDraft(req.params.id, callClaudeEmailDraft);
      res.json(result);
    } catch (err) {
      if (err instanceof InvalidReportTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/:id/regenerate", async (req, res) => {
    try {
      const result = await regenerateEmailDraft(req.params.id, callClaudeEmailDraft);
      res.json(result);
    } catch (err) {
      if (err instanceof InvalidReportTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
