import { Router } from "express";
import multer from "multer";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { findOwnedClientOrRespond, findOwnedReportOrRespond } from "../../auth/ownership.js";
import {
  ConsolidatedFileError,
  ConsolidatedReportUnavailableError,
  buildConsolidatedForReport,
  describeConsolidatedFile,
} from "../../reporting/consolidatedReport.js";

// "Consolidated report" (2026-11-10) -- see backend/reporting/consolidatedReport.ts.
//   Client Management: switch it on per client, upload the client's last consolidated Excel (its history).
//   Report pages: preview/download the consolidated report a report would send.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function historySummary(h: { filename: string; newestDate: Date; dateColumns: number; keywordCount: number; source: string; updatedBy: string | null; updatedAt: Date; reportId: string | null } | null) {
  if (!h) return null;
  return {
    filename: h.filename,
    newestDate: h.newestDate,
    dateColumns: h.dateColumns,
    keywordCount: h.keywordCount,
    source: h.source,
    reportId: h.reportId,
    updatedBy: h.updatedBy,
    updatedAt: h.updatedAt,
  };
}

const HISTORY_SELECT = { filename: true, newestDate: true, dateColumns: true, keywordCount: true, source: true, updatedBy: true, updatedAt: true, reportId: true } as const;

export const consolidatedClientsRouter = Router();
consolidatedClientsRouter.use(requireAuth);

consolidatedClientsRouter.get("/:id/consolidated", async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string);
  if (!client) return;
  const history = await prisma.consolidatedHistory.findUnique({ where: { clientId: client.id }, select: HISTORY_SELECT });
  res.json({ enabled: client.consolidatedReport, history: historySummary(history) });
});

consolidatedClientsRouter.patch("/:id/consolidated", async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string, { requireActive: true });
  if (!client) return;
  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be true or false" });
    return;
  }
  await prisma.client.update({ where: { id: client.id }, data: { consolidatedReport: enabled } });
  const history = await prisma.consolidatedHistory.findUnique({ where: { clientId: client.id }, select: HISTORY_SELECT });
  res.json({ enabled, history: historySummary(history) });
});

/** The team's last consolidated Excel for this client -- every later one adds a column to it. Replaces any earlier one. */
consolidatedClientsRouter.post("/:id/consolidated/history", upload.single("file"), async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string, { requireActive: true });
  if (!client) return;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  let info: Awaited<ReturnType<typeof describeConsolidatedFile>>;
  try {
    info = await describeConsolidatedFile(file.buffer);
  } catch (err) {
    if (err instanceof ConsolidatedFileError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }
  const data = {
    filename: file.originalname,
    file: file.buffer,
    newestDate: info.newestDate,
    dateColumns: info.dateColumns,
    keywordCount: info.keywordCount,
    source: "upload",
    reportId: null,
    updatedBy: req.authUser!.email,
  };
  const saved = await prisma.consolidatedHistory.upsert({ where: { clientId: client.id }, create: { clientId: client.id, ...data }, update: data, select: HISTORY_SELECT });
  res.json({ enabled: client.consolidatedReport, history: historySummary(saved), newestLabel: info.newestLabel });
});

consolidatedClientsRouter.get("/:id/consolidated/history/file", async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string);
  if (!client) return;
  const history = await prisma.consolidatedHistory.findUnique({ where: { clientId: client.id } });
  if (!history) {
    res.status(404).json({ error: "No consolidated history uploaded for this client." });
    return;
  }
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(history.filename)}`);
  res.send(Buffer.from(history.file));
});

export const consolidatedReportsRouter = Router();
consolidatedReportsRouter.use(requireAuth);

/** What this report would send: the new column, the keywords added/left out -- or why it can't be built. */
consolidatedReportsRouter.get("/:id/consolidated/info", async (req, res) => {
  const report = await findOwnedReportOrRespond(req, res, req.params.id as string);
  if (!report) return;
  if (!report.run.client.consolidatedReport) {
    res.json({ enabled: false });
    return;
  }
  try {
    const built = await buildConsolidatedForReport(report.id);
    res.json({ enabled: true, ready: true, filename: built.filename, newColumnLabel: built.newColumnLabel, dateColumns: built.dateColumns, keywordCount: built.keywordCount, added: built.added, dropped: built.dropped });
  } catch (err) {
    if (err instanceof ConsolidatedReportUnavailableError || err instanceof ConsolidatedFileError) {
      res.json({ enabled: true, ready: false, error: err.message });
      return;
    }
    throw err;
  }
});

consolidatedReportsRouter.get("/:id/consolidated", async (req, res) => {
  const report = await findOwnedReportOrRespond(req, res, req.params.id as string);
  if (!report) return;
  try {
    const built = await buildConsolidatedForReport(report.id);
    res.setHeader("Content-Type", XLSX);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(built.filename)}`);
    res.send(built.buffer);
  } catch (err) {
    if (err instanceof ConsolidatedReportUnavailableError || err instanceof ConsolidatedFileError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});
