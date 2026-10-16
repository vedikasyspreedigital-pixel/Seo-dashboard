-- AlterTable
ALTER TABLE "ranking_reports" ADD COLUMN     "email_variant" TEXT NOT NULL DEFAULT 'regular',
ADD COLUMN     "extra_attachments" JSONB NOT NULL DEFAULT '[]';
