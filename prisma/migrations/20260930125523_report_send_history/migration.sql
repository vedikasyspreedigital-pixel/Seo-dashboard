-- CreateTable
CREATE TABLE "report_sends" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_by" TEXT,
    "subject" TEXT,

    CONSTRAINT "report_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_sends_report_id_sent_at_idx" ON "report_sends"("report_id", "sent_at");

-- AddForeignKey
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ranking_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every report already SENT gets its one existing send recorded,
-- so "Sent N times" is right from day one. gen_random_uuid() is built into
-- PostgreSQL 13+.
INSERT INTO "report_sends" ("id", "report_id", "sent_at", "sent_by", "subject")
SELECT gen_random_uuid()::text, r."id", COALESCE(r."sent_at", r."updated_at"), r."approved_by", r."email_subject"
FROM "ranking_reports" r
WHERE r."status" = 'SENT';
