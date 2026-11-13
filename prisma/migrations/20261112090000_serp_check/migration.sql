-- "Poisoned SERP" check result per ranking row (2026-11-12).
ALTER TABLE "ranking_rows" ADD COLUMN "serp_check" JSONB;
