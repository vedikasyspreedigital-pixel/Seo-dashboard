import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Prisma } from "@prisma/client";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { guardedUpdate } from "./reportTransitions.js";

// Extra PDFs attached to a report's email IN ADDITION to the report PDF
// (2026-10-16) -- typically the client's Google Analytics reports (Traffic
// Acquisition, Engagement Overview), uploaded on the email draft page. Works
// the same for SEO and Advanced SEO. Never replaces the report PDF (that's
// the separate "custom PDF" override, customPdfPath).

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

/** Upload-safe display name: no path parts, no characters a file system or ClickUp would choke on, ends in .pdf. */
export function safePdfName(original: string): string {
  const base = path.basename(original || "attachment.pdf").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim() || "attachment.pdf";
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

/** Makes `name` unique among `taken` ("GA.pdf" -> "GA (2).pdf"), so two attachments never share a name on the email. */
export function uniqueName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const stem = name.replace(/\.pdf$/i, "");
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n}).pdf`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Stores uploaded PDFs and appends them to the report's list. Only while the
 * report awaits approval (same guard as every draft edit). Each file must be
 * a real PDF (checked by content) within the size and count limits.
 */
export async function addExtraAttachments(reportId: string, files: { buffer: Buffer; originalname: string }[]) {
  if (files.length === 0) throw new ExtraAttachmentError("Choose at least one PDF to attach.");
  const report = await prisma.rankingReport.findUniqueOrThrow({ where: { id: reportId }, select: { extraAttachments: true } });
  const current = readExtraAttachments(report.extraAttachments);
  if (current.length + files.length > MAX_EXTRA_ATTACHMENTS) {
    throw new ExtraAttachmentError(`At most ${MAX_EXTRA_ATTACHMENTS} extra PDFs per report (this one has ${current.length}).`);
  }
  for (const f of files) {
    if (!f.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new ExtraAttachmentError(`"${f.originalname}" is not a PDF.`);
    if (f.buffer.length > MAX_EXTRA_ATTACHMENT_BYTES) throw new ExtraAttachmentError(`"${f.originalname}" is larger than 15 MB.`);
  }

  const dir = path.join(REPORTS_DIR, "extra", reportId);
  await mkdir(dir, { recursive: true });
  const added: ExtraAttachment[] = [];
  const taken = current.map((a) => a.filename);
  for (const f of files) {
    const id = randomUUID();
    const filename = uniqueName(safePdfName(f.originalname), taken);
    taken.push(filename);
    const storedPath = path.join(dir, `${id}.pdf`);
    await writeFile(storedPath, f.buffer);
    added.push({ id, path: storedPath, filename, size: f.buffer.length, uploadedAt: new Date().toISOString() });
  }
  try {
    return await guardedUpdate(
      reportId,
      [ReportStatus.PENDING_APPROVAL],
      { extraAttachments: [...current, ...added] as unknown as Prisma.InputJsonValue },
      "add extra PDF attachments (report must be PENDING_APPROVAL)",
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
    "remove extra PDF attachment (report must be PENDING_APPROVAL)",
  );
  await unlink(target.path).catch(() => undefined);
  return updated;
}

/** Deletes all of a report's extra PDFs from disk -- used when its run (and so the report) is deleted. Never throws. */
export async function deleteExtraAttachmentFiles(reportId: string, value: unknown): Promise<void> {
  await Promise.all(readExtraAttachments(value).map((a) => unlink(a.path).catch(() => undefined)));
  await rm(path.join(REPORTS_DIR, "extra", reportId), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * The files to send, in upload order. Throws if any is missing on disk --
 * the send then fails visibly instead of reaching the client without a PDF
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
