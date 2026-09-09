-- AlterTable
ALTER TABLE "client_report_configs" ADD COLUMN     "cc" JSONB;

-- AlterTable
ALTER TABLE "ranking_reports" ADD COLUMN     "resolved_cc" JSONB;
