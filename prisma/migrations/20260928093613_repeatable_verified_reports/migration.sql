-- AlterTable
ALTER TABLE "ranking_baselines" ADD COLUMN     "source_run_id" TEXT;

-- AlterTable
ALTER TABLE "ranking_reports" ADD COLUMN     "report_date" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ranking_baselines_client_id_baseline_date_idx" ON "ranking_baselines"("client_id", "baseline_date");

-- CreateIndex
CREATE INDEX "ranking_baselines_source_run_id_idx" ON "ranking_baselines"("source_run_id");

-- AddForeignKey
ALTER TABLE "ranking_baselines" ADD CONSTRAINT "ranking_baselines_source_run_id_fkey" FOREIGN KEY ("source_run_id") REFERENCES "ranking_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: link each baseline that a verified-Excel upload created to its
-- run. That flow always stored baseline_date = the run's completion date and
-- created the baseline right after the report, so a pair is linked only on
-- an exact date match, same client, created within 10 minutes after the
-- report -- and only when that match is unambiguous on both sides. Manual
-- "Upload Previous Ranking" baselines never match and stay unlinked.
WITH candidates AS (
  SELECT b.id AS baseline_id, r.run_id
  FROM "ranking_baselines" b
  JOIN "ranking_reports" r ON r.client_id = b.client_id
  JOIN "ranking_runs" run ON run.id = r.run_id
  WHERE b.source_type = 'EXCEL'
    AND b.baseline_date = COALESCE(run.completed_at, run.created_at)
    AND b.created_at >= r.created_at
    AND b.created_at <= r.created_at + INTERVAL '10 minutes'
),
unambiguous AS (
  SELECT baseline_id, MIN(run_id) AS run_id
  FROM candidates
  WHERE baseline_id IN (SELECT baseline_id FROM candidates GROUP BY baseline_id HAVING COUNT(DISTINCT run_id) = 1)
    AND run_id IN (SELECT run_id FROM candidates GROUP BY run_id HAVING COUNT(DISTINCT baseline_id) = 1)
  GROUP BY baseline_id
)
UPDATE "ranking_baselines" b
SET source_run_id = u.run_id
FROM unambiguous u
WHERE b.id = u.baseline_id;
