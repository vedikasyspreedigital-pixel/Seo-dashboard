-- CreateEnum
CREATE TYPE "DataforseoTaskStatus" AS ENUM ('POSTING', 'SUBMITTED', 'COLLECTING', 'COLLECTED', 'FAILED', 'ABANDONED');

-- AlterTable
ALTER TABLE "ranking_runs" ADD COLUMN     "engine" TEXT NOT NULL DEFAULT 'live';

-- CreateTable
CREATE TABLE "dataforseo_tasks" (
    "id" TEXT NOT NULL,
    "ranking_row_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "dataforseo_task_id" TEXT,
    "status" "DataforseoTaskStatus" NOT NULL DEFAULT 'POSTING',
    "request_payload" JSONB NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "collected_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dataforseo_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dataforseo_tasks_dataforseo_task_id_key" ON "dataforseo_tasks"("dataforseo_task_id");

-- CreateIndex
CREATE INDEX "dataforseo_tasks_status_idx" ON "dataforseo_tasks"("status");

-- CreateIndex
CREATE INDEX "dataforseo_tasks_run_id_status_idx" ON "dataforseo_tasks"("run_id", "status");

-- CreateIndex
CREATE INDEX "dataforseo_tasks_ranking_row_id_idx" ON "dataforseo_tasks"("ranking_row_id");

-- AddForeignKey
ALTER TABLE "dataforseo_tasks" ADD CONSTRAINT "dataforseo_tasks_ranking_row_id_fkey" FOREIGN KEY ("ranking_row_id") REFERENCES "ranking_rows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
