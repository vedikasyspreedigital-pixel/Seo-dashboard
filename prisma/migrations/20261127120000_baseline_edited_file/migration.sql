-- The team's edited Baseline Report client copy (2026-11-27).
ALTER TABLE "baseline_jobs" ADD COLUMN "edited_file_name" TEXT;
ALTER TABLE "baseline_jobs" ADD COLUMN "edited_by" TEXT;
ALTER TABLE "baseline_jobs" ADD COLUMN "edited_at" TIMESTAMP(3);
