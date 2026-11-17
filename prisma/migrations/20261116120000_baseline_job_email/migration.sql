-- Baseline Report tab: email the Baseline Excel to the new client once, through ClickUp.
ALTER TABLE "baseline_jobs" ADD COLUMN "sending_at" TIMESTAMP(3);
ALTER TABLE "baseline_jobs" ADD COLUMN "sent_at" TIMESTAMP(3);
ALTER TABLE "baseline_jobs" ADD COLUMN "sent_by" TEXT;
ALTER TABLE "baseline_jobs" ADD COLUMN "sent_to" JSONB;
ALTER TABLE "baseline_jobs" ADD COLUMN "sent_cc" JSONB;
ALTER TABLE "baseline_jobs" ADD COLUMN "sent_subject" TEXT;
ALTER TABLE "baseline_jobs" ADD COLUMN "clickup_task_url" TEXT;
ALTER TABLE "baseline_jobs" ADD COLUMN "send_error" TEXT;
