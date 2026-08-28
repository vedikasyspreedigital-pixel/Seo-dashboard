-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING_ANALYSIS', 'ANALYSIS_FAILED', 'ANALYSIS_READY', 'REPORT_READY', 'EMAIL_DRAFT_FAILED', 'EMAIL_DRAFTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SENT');

-- CreateTable
CREATE TABLE "ranking_reports" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "previous_run_id" TEXT,
    "client_id" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING_ANALYSIS',
    "analytics_json" JSONB,
    "analysis_json" JSONB,
    "report_html" TEXT,
    "email_subject" TEXT,
    "email_body" TEXT,
    "resolved_recipients" JSONB,
    "last_error_message" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranking_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ranking_reports_client_id_status_idx" ON "ranking_reports"("client_id", "status");

-- CreateIndex
CREATE INDEX "ranking_reports_run_id_idx" ON "ranking_reports"("run_id");

-- AddForeignKey
ALTER TABLE "ranking_reports" ADD CONSTRAINT "ranking_reports_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ranking_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_reports" ADD CONSTRAINT "ranking_reports_previous_run_id_fkey" FOREIGN KEY ("previous_run_id") REFERENCES "ranking_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_reports" ADD CONSTRAINT "ranking_reports_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
