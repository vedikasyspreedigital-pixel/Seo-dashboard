import { Router } from "express";
import multer from "multer";
import { prisma } from "../../db/client.js";
import { requireAuth } from "../../auth/requireAuth.js";
import { findOwnedClientOrRespond } from "../../auth/ownership.js";
import { parseBaselineFile } from "../../baselines/parseBaselineFile.js";
import { normalizeKeyword } from "../../baselines/normalizeKeyword.js";
import { BaselineSourceType } from "@prisma/client";

// Previous-ranking baseline upload: Excel OR PDF, per the client-onboarding
// requirement ("fresh clients may provide their existing ranking history as
// a PDF"). Two-step preview -> confirm, matching the explicit requirement
// to show the extraction before storing anything: /preview parses and
// returns rows + the auto-detected (never user-picked) baseline date
// without touching the DB; /confirm persists exactly that same data, passed
// back by the client rather than re-parsed, so a second (possibly
// non-deterministic, for the OCR path) parse can never silently diverge
// from what the user actually reviewed.

export const baselinesRouter = Router();

baselinesRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

baselinesRouter.post("/:id/baselines/preview", upload.single("file"), async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string, { requireActive: true });
  if (!client) return;

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "file is required" });
    return;
  }

  try {
    const preview = await parseBaselineFile(file.buffer);
    res.json({ ...preview, sourceFilename: file.originalname });
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});

interface ConfirmBaselineRow {
  keyword: string;
  rankValue: number | null;
  rankDisplay: string | null;
}

baselinesRouter.post("/:id/baselines", async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string, { requireActive: true });
  if (!client) return;

  const { sourceFilename, sourceType, baselineDate, rows } = req.body ?? {};
  if (typeof sourceFilename !== "string" || sourceFilename.length === 0) {
    res.status(400).json({ error: "sourceFilename is required" });
    return;
  }
  if (sourceType !== "EXCEL" && sourceType !== "PDF") {
    res.status(400).json({ error: 'sourceType must be "EXCEL" or "PDF"' });
    return;
  }
  const parsedDate = typeof baselineDate === "string" ? new Date(baselineDate) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
    res.status(400).json({ error: "baselineDate must be a valid ISO date string" });
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "rows must be a non-empty array" });
    return;
  }
  const typedRows = rows as ConfirmBaselineRow[];
  for (const row of typedRows) {
    if (typeof row.keyword !== "string" || row.keyword.trim().length === 0) {
      res.status(400).json({ error: "Every row must have a non-empty keyword" });
      return;
    }
  }

  const baseline = await prisma.rankingBaseline.create({
    data: {
      clientId: client.id,
      sourceFilename,
      sourceType: sourceType as BaselineSourceType,
      baselineDate: parsedDate,
      createdBy: req.authUser!.email,
      rows: {
        create: typedRows.map((row) => ({
          keyword: row.keyword,
          normalizedKeyword: normalizeKeyword(row.keyword),
          rankValue: row.rankValue ?? null,
          rankDisplay: row.rankDisplay ?? null,
        })),
      },
    },
  });

  res.status(201).json({ id: baseline.id, sourceFilename: baseline.sourceFilename, sourceType: baseline.sourceType, baselineDate: baseline.baselineDate, rowCount: typedRows.length });
});

baselinesRouter.get("/:id/baselines", async (req, res) => {
  const client = await findOwnedClientOrRespond(req, res, req.params.id as string);
  if (!client) return;

  const baselines = await prisma.rankingBaseline.findMany({
    where: { clientId: client.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, sourceFilename: true, sourceType: true, baselineDate: true, createdAt: true, _count: { select: { rows: true } } },
  });
  res.json(baselines.map((b) => ({ ...b, rowCount: b._count.rows, _count: undefined })));
});
