-- "Baseline Report" tab on Domain Intelligence (2026-11-13): a typed keyword list checked as a run, then the Baseline Excel.
-- CreateTable
CREATE TABLE "baseline_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "created_by" TEXT,
    "volumes_fetched_at" TIMESTAMP(3),
    "volumes_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "baseline_jobs_run_id_key" ON "baseline_jobs"("run_id");

-- CreateIndex
CREATE INDEX "baseline_jobs_workspace_id_created_at_idx" ON "baseline_jobs"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "baseline_jobs" ADD CONSTRAINT "baseline_jobs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baseline_jobs" ADD CONSTRAINT "baseline_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ranking_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

