-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('RUN_COMPLETED', 'RUN_COMPLETED_WITH_ERRORS', 'REPORT_SENT', 'REPORT_SEND_FAILED');

-- CreateEnum
CREATE TYPE "BaselineSourceType" AS ENUM ('EXCEL', 'PDF');

-- AlterTable
ALTER TABLE "ranking_reports" ADD COLUMN     "previous_baseline_id" TEXT;

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "client_id" TEXT,
    "run_id" TEXT,
    "report_id" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_baselines" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "source_filename" TEXT NOT NULL,
    "source_type" "BaselineSourceType" NOT NULL,
    "baseline_date" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranking_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_baseline_rows" (
    "id" TEXT NOT NULL,
    "baseline_id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "normalized_keyword" TEXT NOT NULL,
    "rank_value" INTEGER,
    "rank_display" TEXT,

    CONSTRAINT "ranking_baseline_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_workspace_id_read_idx" ON "notifications"("workspace_id", "read");

-- CreateIndex
CREATE INDEX "ranking_baselines_client_id_created_at_idx" ON "ranking_baselines"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "ranking_baseline_rows_baseline_id_normalized_keyword_idx" ON "ranking_baseline_rows"("baseline_id", "normalized_keyword");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_baselines" ADD CONSTRAINT "ranking_baselines_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_baseline_rows" ADD CONSTRAINT "ranking_baseline_rows_baseline_id_fkey" FOREIGN KEY ("baseline_id") REFERENCES "ranking_baselines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_reports" ADD CONSTRAINT "ranking_reports_previous_baseline_id_fkey" FOREIGN KEY ("previous_baseline_id") REFERENCES "ranking_baselines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
