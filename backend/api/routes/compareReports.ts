import { Router, json } from "express";
import multer from "multer";
import { requireAuth } from "../../auth/requireAuth.js";
import { expensiveActionRateLimit } from "../rateLimit.js";
import {
  CompareReportsError,
  analyticsFromRows,
  compareRankingFiles,
  locationsFromRows,
  sanitizeComparedRows,
} from "../../reporting/compareReportFiles.js";
import { generateClientReportPdf } from "../../reporting/generateClientReportPdf.js";
import { formatOrdinalDate } from "../../reporting/formatOrdinalDate.js";

// "Compare Reports" tab -- two rankings Excels from the user's own folder
// (each with the date the user picked) in, one comparison PDF out. Stateless by design: nothing here reads or writes
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
      res.status(400).json({ error: "Upload both rankings Excels." });
      return;
    }
    try {
      const result = await compareRankingFiles(
        { buffer: f1.buffer, name: f1.originalname, date: DAY(req.body?.date1) },
        { buffer: f2.buffer, name: f2.originalname, date: DAY(req.body?.date2) },
      );
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

// Date picker value "2026-09-30" -> midnight UTC that day (how ranking dates are stored elsewhere).
const DAY = (raw: unknown) => (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? DATE(raw + "T00:00:00.000Z") : null);

function DATE(raw: unknown) {
  const d = typeof raw === "string" ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
const TEXT = (raw: unknown, max: number) => (typeof raw === "string" ? raw.trim().slice(0, max) : "");

compareReportsRouter.post("/pdf", expensiveActionRateLimit, json({ limit: "2mb" }), async (req, res) => {
  const body = req.body ?? {};
  const olderDate = DATE(body.olderDate);
  const newerDate = DATE(body.newerDate);
  if (!olderDate || !newerDate) {
    res.status(400).json({ error: "Both dates are required." });
    return;
  }
  try {
    const currentRows = sanitizeComparedRows(body.currentRows, "Newer report");
    const previousRows = sanitizeComparedRows(body.previousRows, "Older report");
    const clientName = TEXT(body.clientName, 200) || "Client";
    const clientDomain = TEXT(body.clientDomain, 200) || null;

    // Recomputed here from the validated rows -- the browser never supplies the comparison itself.
    const analytics = analyticsFromRows(currentRows, previousRows);
    const locations = locationsFromRows(currentRows, previousRows);
    const pdf = await generateClientReportPdf({
      clientName,
      clientDomain,
      searchEngineDomains: [locations.labels[locations.order[0]].seDomain].filter(Boolean),
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
