import { Router, json } from "express";
import multer from "multer";
import { requireAuth } from "../../auth/requireAuth.js";
import { expensiveActionRateLimit } from "../rateLimit.js";
import {
  CompareReportsError,
  analyticsFromRows,
  compareReportFiles,
  locationsFromRows,
  sanitizeComparedRows,
} from "../../reporting/compareReportFiles.js";
import { generateClientReportPdf } from "../../reporting/generateClientReportPdf.js";
import { formatOrdinalDate } from "../../reporting/formatOrdinalDate.js";

// "Compare Reports" tab -- two report files from the user's own folder in,
// one comparison PDF out. Stateless by design: nothing here reads or writes
// any client, run, baseline or report, calls DataForSEO, or sends email.

export const compareReportsRouter = Router();
compareReportsRouter.use(requireAuth);

// Same limit as the Previous Ranking upload (baselines.ts).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 2 } });

compareReportsRouter.post(
  "/preview",
  expensiveActionRateLimit,
  upload.fields([{ name: "file1", maxCount: 1 }, { name: "file2", maxCount: 1 }]),
  async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const f1 = files?.file1?.[0];
    const f2 = files?.file2?.[0];
    if (!f1 || !f2) {
      res.status(400).json({ error: "Upload both reports." });
      return;
    }
    try {
      const result = await compareReportFiles({ buffer: f1.buffer, name: f1.originalname }, { buffer: f2.buffer, name: f2.originalname });
      res.json(result);
    } catch (err) {
      if (err instanceof CompareReportsError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

const DATE = (raw: unknown) => {
  const d = typeof raw === "string" ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const TEXT = (raw: unknown, max: number) => (typeof raw === "string" ? raw.trim().slice(0, max) : "");

compareReportsRouter.post("/pdf", expensiveActionRateLimit, json({ limit: "2mb" }), async (req, res) => {
  const body = req.body ?? {};
  const olderDate = DATE(body.olderDate);
  const newerDate = DATE(body.newerDate);
  if (!olderDate || !newerDate) {
    res.status(400).json({ error: "Both report dates are required." });
    return;
  }
  try {
    const currentRows = sanitizeComparedRows(body.currentRows, "Newer report");
    const previousRows = sanitizeComparedRows(body.previousRows, "Older report");
    const sections = Array.isArray(body.sections)
      ? (body.sections as unknown[])
          .filter((s): s is { name: string; domain: string } => !!s && typeof (s as any).name === "string" && typeof (s as any).domain === "string")
          .slice(0, 100)
          .map((s) => ({ name: TEXT(s.name, 200), domain: TEXT(s.domain, 100).toLowerCase() }))
      : [];
    const primarySearchDomain = TEXT(body.primarySearchDomain, 100).toLowerCase() || null;
    const clientName = TEXT(body.clientName, 200) || "Client";
    const clientDomain = TEXT(body.clientDomain, 200) || null;

    // Recomputed here from the validated rows -- the browser never supplies the comparison itself.
    const analytics = analyticsFromRows(currentRows, previousRows);
    const locations = locationsFromRows(currentRows, sections, primarySearchDomain);
    const pdf = await generateClientReportPdf({
      clientName,
      clientDomain,
      searchEngineDomains: primarySearchDomain ? [primarySearchDomain] : [],
      locations,
      currentRunDate: newerDate,
      previousRunDate: olderDate,
      analytics,
    });
    const safeName = clientName.replace(/[\\/:*?"<>|]/g, "").trim() || "Client";
    const filename = `${safeName} - Keyword Ranking Report - ${formatOrdinalDate(olderDate)} - ${formatOrdinalDate(newerDate)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    res.send(pdf);
  } catch (err) {
    if (err instanceof CompareReportsError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }
});
