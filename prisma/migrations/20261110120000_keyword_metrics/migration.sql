-- "Baseline Report" (2026-11-10): Keyword Planner volume/competition per client keyword.
CREATE TABLE "keyword_metrics" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "normalized_keyword" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "avg_monthly_searches" TEXT,
    "competition" TEXT,
    "source" TEXT NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "keyword_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "keyword_metrics_client_id_normalized_keyword_key" ON "keyword_metrics"("client_id", "normalized_keyword");

ALTER TABLE "keyword_metrics" ADD CONSTRAINT "keyword_metrics_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
