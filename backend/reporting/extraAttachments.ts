import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Prisma } from "@prisma/client";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { guardedUpdate } from "./reportTransitions.js";

// Extra files attached to a report's email IN ADDITION to the report PDF
// (2026-10-16) -- typically the client's Google Analytics reports (Traffic
// Acquisition, Engagement Overview), uploaded on the email draft page. PDFs
// or Excel files (2026-11-03). Works the same for SEO and Advanced SEO.
// Never replaces the report PDF (that's the separate "custom PDF" override,
// customPdfPath); the report PDF can instead be left off entirely with
// attachmentSource "none", so only these files are sent.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same env-var/fallback convention as buildReport.ts / reports.ts.
const REPORTS_DIR = process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.resolve(__dirname, "../../reports");

export const MAX_EXTRA_ATTACHMENTS = 5;
export const MAX_EXTRA_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export interface ExtraAttachment {
  id: string;
  /** Where the file is stored on disk. */
  path: string;
  /** The uploaded name -- what the client sees on the email. */
  filename: string;
  size: number;
  uploadedAt: string;
}

export class ExtraAttachmentError extends Error {}

/** The report's extraAttachments JSON as a typed list (anything malformed is dropped). */
export function readExtraAttachments(value: unknown): ExtraAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (a): a is ExtraAttachment => !!a && typeof a.id === "string" && typeof a.path === "string" && typeof a.filename === "string",
  );
}

// What may be attached besides the report PDF, checked by CONTENT (a
// filename or mimetype is trivially spoofable): PDFs, and Excel files the
// team prepares themselves (2026-11-03). .xlsx is a zip, .xls an OLE
// compound file -- each must also carry the matching extension.
const FILE_KINDS = [
  { ext: ".pdf", magic: Buffer.from("%PDF-") },
  { ext: ".xlsx", magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
  { ext: ".xls", magic: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
];

/** The file's extension (".pdf" / ".xlsx" / ".xls") if its content really is that kind of file, else null. */
export function attachmentKind(buffer: Buffer, originalname: string): string | null {
  const ext = path.extname(originalname || "").toLowerCase();
  const byContent = FILE_KINDS.filter((k) => buffer.subarray(0, k.magic.length).equals(k.magic));
  if (byContent.length === 0) return null;
  // A named .xlsx/.xls must match its content; an unnamed or oddly-named PDF is still a PDF.
  const named = byContent.find((k) => k.ext === ext);
  if (named) return named.ext;
  return byContent.some((k) => k.ext === ".pdf") ? ".pdf" : null;
}

/** Upload-safe display name: no path parts, no characters a file system or ClickUp would choke on, ends in `ext`. */
export function safeAttachmentName(original: string, ext = ".pdf"): string {
  const fallback = `attachment${ext}`;
  const base = path.basename(original || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim() || fallback;
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}

/** @deprecated name kept for existing callers -- a PDF display name. */
export function safePdfName(original: string): string {
  return safeAttachmentName(original, ".pdf");
}

/** Makes `name` unique among `taken` ("GA.pdf" -> "GA (2).pdf"), so two attachments never share a name on the email. */
export function uniqueName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Stores uploaded files and appends them to the report's list. Only while the
 * report awaits approval (same guard as every draft edit). Each file must be
 * a real PDF or Excel file (checked by content) within the size and count limits.
 */
export async function addExtraAttachments(reportId: string, files: { buffer: Buffer; originalname: string }[]) {
  if (files.length === 0) throw new ExtraAttachmentError("Choose at least one PDF or Excel file to attach.");
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId }, select: { extraAttachments: true } });
  const current = readExtraAttachments(report.extraAttachments);
  if (current.length + files.length > MAX_EXTRA_ATTACHMENTS) {
    throw new ExtraAttachmentError(`At most ${MAX_EXTRA_ATTACHMENTS} extra files per report (this one has ${current.length}).`);
  }
  const kinds: string[] = [];
  for (const f of files) {
    const kind = attachmentKind(f.buffer, f.originalname);
    if (!kind) throw new ExtraAttachmentError(`"${f.originalname}" is not a PDF or Excel (.xlsx/.xls) file.`);
    if (f.buffer.length > MAX_EXTRA_ATTACHMENT_BYTES) throw new ExtraAttachmentError(`"${f.originalname}" is larger than 15 MB.`);
    kinds.push(kind);
  }

  const dir = path.join(REPORTS_DIR, "extra", reportId);
  await mkdir(dir, { recursive: true });
  const added: ExtraAttachment[] = [];
  const taken = current.map((a) => a.filename);
  for (const [i, f] of files.entries()) {
    const id = randomUUID();
    const filename = uniqueName(safeAttachmentName(f.originalname, kinds[i]), taken);
    taken.push(filename);
    const storedPath = path.join(dir, `${id}${kinds[i]}`);
    await writeFile(storedPath, f.buffer);
    added.push({ id, path: storedPath, filename, size: f.buffer.length, uploadedAt: new Date().toISOString() });
  }
  try {
    return await guardedUpdate(
      reportId,
      [ReportStatus.PENDING_APPROVAL],
      { extraAttachments: [...current, ...added] as unknown as Prisma.InputJsonValue },
      "add extra attachments (report must be PENDING_APPROVAL)",
    );
  } catch (err) {
    // Not recorded -- don't leave orphan files behind.
    await Promise.all(added.map((a) => unlink(a.path).catch(() => undefined)));
    throw err;
  }
}

/** Removes one extra attachment from the report (and its file). Only while the report awaits approval. */
export async function removeExtraAttachment(reportId: string, attachmentId: string) {
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId }, select: { extraAttachments: true } });
  const current = readExtraAttachments(report.extraAttachments);
  const target = current.find((a) => a.id === attachmentId);
  if (!target) throw new ExtraAttachmentError("That attachment is not on this report.");
  const updated = await guardedUpdate(
    reportId,
    [ReportStatus.PENDING_APPROVAL],
    { extraAttachments: current.filter((a) => a.id !== attachmentId) as unknown as Prisma.InputJsonValue },
    "remove extra attachment (report must be PENDING_APPROVAL)",
  );
  await unlink(target.path).catch(() => undefined);
  return updated;
}

/** Deletes all of a report's extra files from disk -- used when its run (and so the report) is deleted. Never throws. */
export async function deleteExtraAttachmentFiles(reportId: string, value: unknown): Promise<void> {
  await Promise.all(readExtraAttachments(value).map((a) => unlink(a.path).catch(() => undefined)));
  await rm(path.join(REPORTS_DIR, "extra", reportId), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * The files to send, in upload order. Throws if any is missing on disk --
 * the send then fails visibly instead of reaching the client without a file
 * the email text says is attached.
 */
export async function loadExtraAttachmentFiles(value: unknown): Promise<{ buffer: Buffer; filename: string }[]> {
  const out: { buffer: Buffer; filename: string }[] = [];
  for (const a of readExtraAttachments(value)) {
    try {
      out.push({ buffer: await readFile(a.path), filename: a.filename });
    } catch (err) {
      throw new Error(`Extra attachment "${a.filename}" is missing on disk -- remove it and upload it again before sending. (${(err as Error).message})`);
    }
  }
  return out;
}

// The eye button's in-page viewer for an Excel attachment: each sheet's cells
// as display text (what Excel shows), capped so a huge sheet can't stall the
// page. Only .xlsx can be read -- an old .xls returns null (download it instead).
export const PREVIEW_MAX_ROWS = 500;
export const PREVIEW_MAX_COLS = 30;

export async function previewExcelAttachment(filePath: string): Promise<{ sheets: { name: string; rows: string[][]; truncated: boolean }[] } | null> {
  if (path.extname(filePath).toLowerCase() !== ".xlsx") return null;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return {
    sheets: workbook.worksheets.map((ws) => {
      const rows: string[][] = [];
      const cols = Math.min(ws.columnCount, PREVIEW_MAX_COLS);
      for (let r = 1; r <= Math.min(ws.rowCount, PREVIEW_MAX_ROWS); r++) {
        const row = ws.getRow(r);
        rows.push(Array.from({ length: cols }, (_, c) => row.getCell(c + 1).text ?? ""));
      }
      return { name: ws.name, rows, truncated: ws.rowCount > PREVIEW_MAX_ROWS || ws.columnCount > PREVIEW_MAX_COLS };
    }),
  };
}
