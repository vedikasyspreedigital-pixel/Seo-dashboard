-- AlterTable
ALTER TABLE "ranking_reports" ADD COLUMN     "attachment_source" TEXT NOT NULL DEFAULT 'generated',
ADD COLUMN     "custom_pdf_filename" TEXT,
ADD COLUMN     "custom_pdf_path" TEXT;
