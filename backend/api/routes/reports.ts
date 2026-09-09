import { Router } from "express";
import { prisma } from "../../db/client.js";
import { rejectReport } from "../../reporting/reportTransitions.js";
import { updateReportDraft } from "../../reporting/editReportDraft.js";
import { approveAndSendReport } from "../../reporting/approveAndSend.js";
import { generateEmailDraft, regenerateEmailDraft } from "../../reporting/generateEmailDraft.js";
import { createReportForRun } from "../../reporting/createReport.js";
import { buildReport } from "../../reporting/buildReport.js";
import { InvalidReportTransitionError } from "../../reporting/errors.js";
import type { SendEmailFn } from "../../reporting/emailSender.js";
import type { GenerateExcelAttachmentFn } from "../../reporting/generateExcelAttachment.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { findOwnedClientOrRespond, findOwnedRunOrRespond, findOwnedReportOrRespond } from "../../auth/ownership.js";

// Mirrors frontend/src/components/report/reportStatus.ts's isValidEmailAddress
// exactly -- the frontend already blocks invalid entries before Save Changes
// is even clickable, this is the backend-side enforcement of that same rule
// so a malformed address can't reach the database (and therefore the
// eventual send) via a direct API call that skips the UI.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ReportsRouterDeps {
  sendEmail: SendEmailFn;
  /** Optional: omit to send without the Excel-as-PDF attachment (e.g. in tests). */
  generateExcelAttachment?: GenerateExcelAttachmentFn;
}

export function createReportsRouter({ sendEmail, generateExcelAttachment }: ReportsRouterDeps) {
  const router = Router();
  router.use(requireAuth);

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
    if (!(await findOwnedRunOrRespond(req, res, runId, { requireActive: true }))) return;
    // previousRunId is a runId too -- validated the same way, so a report
    // can never be created diffed against another workspace's run either.
    // Not requireActive here: it's only used for historical comparison data,
    // not the client being acted on -- if the PRIMARY run's client is
    // active (checked above), diffing against an older run is fine even if
    // that older run happens to predate the client being archived later.
    if (previousRunId !== undefined && !(await findOwnedRunOrRespond(req, res, previousRunId))) return;

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
    if (!(await findOwnedClientOrRespond(req, res, clientId))) return;
    const reports = await prisma.rankingReport.findMany({
      where: { clientId },
      include: { run: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(reports);
  });

  // The "Build Report" wizard step: PENDING_ANALYSIS|ANALYSIS_READY ->
  // REPORT_READY. Deterministic -- no Claude call. Generates the
  // client-facing PDF once and stores it; does not send anything.
  router.post("/:id/build-report", async (req, res) => {
    if (!(await findOwnedReportOrRespond(req, res, req.params.id, { requireActive: true }))) return;
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

  // Streams the exact PDF artifact written by buildReport -- backs the PDF
  // Preview page's viewer AND is the same file generateExcelPdfAttachment
  // reads at send time. One generated file, read twice, never regenerated.
  router.get("/:id/pdf", async (req, res) => {
    const report = await findOwnedReportOrRespond(req, res, req.params.id);
    if (!report) return;
    if (!report.clientPdfPath) {
      res.status(404).json({ error: "Report has no generated PDF yet -- build the report first." });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(report.clientPdfPath);
  });

  // Preview: the full report -- analytics, analysis, rendered HTML, and
  // the current email draft/recipients/status, all in one place.
  router.get("/:id", async (req, res) => {
    if (!(await findOwnedReportOrRespond(req, res, req.params.id))) return;
    // Re-fetched with the original include shape (client/run/previousRun,
    // no nested run.client) -- the ownership check above already confirmed
    // this id is safe to return; this second query keeps the response
    // shape exactly what the frontend has always gotten.
    const report = await prisma.rankingReport.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { client: true, run: true, previousRun: true },
    });
    res.json(report);
  });

  // Edit recipients/cc/subject/body -- only while the report is sitting in
  // the approval queue (PENDING_APPROVAL). Human editing, never AI-decided.
  // These are the exact values approveAndSendReport reads at send time
  // (see approveAndSend.ts) -- there is no separate "confirmed" copy, so
  // validating and persisting here IS what the eventual send uses.
  router.patch("/:id", async (req, res) => {
    if (!(await findOwnedReportOrRespond(req, res, req.params.id, { requireActive: true }))) return;
    const { emailSubject, emailBody, emailBodyHtml, resolvedRecipients, resolvedCc, resolvedClickupTaskUrl } = req.body ?? {};
    if (resolvedRecipients !== undefined) {
      if (!Array.isArray(resolvedRecipients)) {
        res.status(400).json({ error: "resolvedRecipients must be an array of email addresses" });
        return;
      }
      const invalidRecipients = resolvedRecipients.filter((r: unknown) => typeof r !== "string" || !EMAIL_PATTERN.test(r));
      if (invalidRecipients.length > 0) {
        res.status(400).json({ error: `resolvedRecipients contains invalid email address(es): ${invalidRecipients.join(", ")}` });
        return;
      }
    }
    // Cc is optional -- unlike resolvedRecipients, an empty array is valid
    // and expected (most reports have no cc at all).
    if (resolvedCc !== undefined) {
      if (!Array.isArray(resolvedCc)) {
        res.status(400).json({ error: "resolvedCc must be an array of email addresses" });
        return;
      }
      const invalidCc = resolvedCc.filter((r: unknown) => typeof r !== "string" || !EMAIL_PATTERN.test(r));
      if (invalidCc.length > 0) {
        res.status(400).json({ error: `resolvedCc contains invalid email address(es): ${invalidCc.join(", ")}` });
        return;
      }
    }
    if (resolvedClickupTaskUrl !== undefined && resolvedClickupTaskUrl !== null && typeof resolvedClickupTaskUrl !== "string") {
      res.status(400).json({ error: "resolvedClickupTaskUrl must be a string or null" });
      return;
    }
    try {
      const updated = await updateReportDraft(req.params.id, { emailSubject, emailBody, emailBodyHtml, resolvedRecipients, resolvedCc, resolvedClickupTaskUrl });
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
    if (!(await findOwnedReportOrRespond(req, res, req.params.id, { requireActive: true }))) return;
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
    if (!(await findOwnedReportOrRespond(req, res, req.params.id, { requireActive: true }))) return;
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
    if (!(await findOwnedReportOrRespond(req, res, req.params.id, { requireActive: true }))) return;
    try {
      const result = await generateEmailDraft(req.params.id);
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
    if (!(await findOwnedReportOrRespond(req, res, req.params.id, { requireActive: true }))) return;
    try {
      const result = await regenerateEmailDraft(req.params.id);
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
