-- AlterTable
ALTER TABLE "report_sends" ADD COLUMN     "manual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source_filename" TEXT;
