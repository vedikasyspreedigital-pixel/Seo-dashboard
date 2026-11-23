-- Run queue (2026-11-23): started runs wait their turn; urgent ones go to the front.
ALTER TYPE "RunStatus" ADD VALUE 'QUEUED' BEFORE 'PROCESSING';
ALTER TYPE "NotificationType" ADD VALUE 'RUN_MADE_URGENT';

ALTER TABLE "ranking_runs" ADD COLUMN "queued_at" TIMESTAMP(3);
ALTER TABLE "ranking_runs" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ranking_runs" ADD COLUMN "urgent_reason" TEXT;
ALTER TABLE "ranking_runs" ADD COLUMN "urgent_by" TEXT;
ALTER TABLE "ranking_runs" ADD COLUMN "urgent_at" TIMESTAMP(3);
