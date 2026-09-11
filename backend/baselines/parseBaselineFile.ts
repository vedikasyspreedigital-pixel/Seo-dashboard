import { parseBaselineExcel, type BaselinePreview } from "./parseBaselineExcel.js";
import { parseBaselinePdf } from "./parseBaselinePdf.js";
import { BaselineSourceType } from "@prisma/client";

export type { BaselinePreview, BaselinePreviewRow } from "./parseBaselineExcel.js";

const PDF_MAGIC = Buffer.from("%PDF-");
const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04" -- .xlsx is a zip archive

/**
 * Dispatches by the file's actual content (magic bytes), never by filename
 * extension or the client-supplied mimetype -- same principle as the
 * existing custom-PDF-upload validation (reports.ts).
 */
export async function parseBaselineFile(buffer: Buffer): Promise<BaselinePreview & { sourceType: BaselineSourceType }> {
  if (buffer.subarray(0, 5).equals(PDF_MAGIC)) {
    return { ...(await parseBaselinePdf(buffer)), sourceType: BaselineSourceType.PDF };
  }
  if (buffer.subarray(0, 4).equals(XLSX_MAGIC)) {
    return { ...(await parseBaselineExcel(buffer)), sourceType: BaselineSourceType.EXCEL };
  }
  throw new Error("Unrecognized file type -- please upload a .xlsx or .pdf file.");
}
