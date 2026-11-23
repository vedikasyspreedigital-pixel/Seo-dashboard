-- Run slots (2026-11-23): each team books when its runs go; reminder + "Start all" into the run queue.
ALTER TYPE "NotificationType" ADD VALUE 'RUN_SLOT_DUE';

CREATE TABLE "run_slots" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 180,
    "repeat_days" INTEGER,
    "client_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "created_by" TEXT,
    "notified_at" TIMESTAMP(3),
    "started_for_slot_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "started_by" TEXT,
    "last_result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_slots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "run_slots_starts_at_idx" ON "run_slots"("starts_at");

ALTER TABLE "run_slots" ADD CONSTRAINT "run_slots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
