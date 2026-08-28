-- AlterTable
ALTER TABLE "client_report_configs" ADD COLUMN     "clickup_task_url" TEXT;

-- AlterTable
ALTER TABLE "ranking_reports" ADD COLUMN     "resolved_clickup_task_url" TEXT;
