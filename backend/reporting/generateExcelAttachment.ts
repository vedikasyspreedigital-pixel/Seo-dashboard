import { exportRunExcelBuffer } from "../excel/exportRunExcel.js";
import { convertExcelBufferToPdf } from "./excelToPdf.js";

export interface ExcelAttachment {
  buffer: Buffer;
  filename: string;
}

export type GenerateExcelAttachmentFn = (runId: string) => Promise<ExcelAttachment>;

/**
 * Real implementation: re-patches the run's original upload with current
 * row state (same file "Download Excel" produces) and converts it to PDF.
 * Injected into approveAndSendReport exactly like sendEmail/callClaudeAnalyst
 * -- kept optional there so tests that construct fixture runs with fake
 * sourceFilePath values (no real file on disk) aren't forced to exercise
 * real file I/O or launch a real Playwright browser just to approve a report.
 */
export async function generateExcelPdfAttachment(runId: string): Promise<ExcelAttachment> {
  const { buffer: excelBuffer, filename: excelFilename } = await exportRunExcelBuffer(runId);
  const pdfBuffer = await convertExcelBufferToPdf(excelBuffer);
  return { buffer: pdfBuffer, filename: `${excelFilename.replace(/\.xlsx$/i, "")}.pdf` };
}
