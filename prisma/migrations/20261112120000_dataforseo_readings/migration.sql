-- Several DataForSEO readings per keyword, median applied (2026-11-12).
ALTER TABLE "dataforseo_tasks" ADD COLUMN "group_id" TEXT;
ALTER TABLE "dataforseo_tasks" ADD COLUMN "reading" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "dataforseo_tasks" ADD COLUMN "reading_ok" BOOLEAN;
ALTER TABLE "dataforseo_tasks" ADD COLUMN "reading_rank" INTEGER;
ALTER TABLE "dataforseo_tasks" ADD COLUMN "reading_display" TEXT;
ALTER TABLE "dataforseo_tasks" ADD COLUMN "reading_url" TEXT;
ALTER TABLE "dataforseo_tasks" ADD COLUMN "result_body" JSONB;
ALTER TABLE "dataforseo_tasks" ADD COLUMN "finalized_at" TIMESTAMP(3);
CREATE INDEX "dataforseo_tasks_group_id_idx" ON "dataforseo_tasks"("group_id");
ALTER TABLE "ranking_rows" ADD COLUMN "readings" JSONB;
