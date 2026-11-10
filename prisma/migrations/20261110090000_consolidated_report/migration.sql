-- "Consolidated report" (2026-11-10): per-client switch + the client's consolidated Excel so far.
ALTER TABLE "clients" ADD COLUMN "consolidated_report" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "consolidated_histories" (
    "client_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "file" BYTEA NOT NULL,
    "newest_date" TIMESTAMP(3) NOT NULL,
    "date_columns" INTEGER NOT NULL,
    "keyword_count" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "report_id" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidated_histories_pkey" PRIMARY KEY ("client_id")
);

ALTER TABLE "consolidated_histories" ADD CONSTRAINT "consolidated_histories_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
