-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RowStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'ERROR_RETRY', 'FAILED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('SUCCESS', 'API_ERROR', 'MAPPING_ERROR');

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_runs" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "source_filename" TEXT NOT NULL,
    "source_file_path" TEXT NOT NULL,
    "result_file_path" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'UPLOADED',
    "total_rows" INTEGER NOT NULL,
    "created_by" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranking_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_rows" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "row_uid" TEXT NOT NULL,
    "source_row_number" INTEGER NOT NULL,
    "keyword" TEXT NOT NULL,
    "full_url" TEXT,
    "target_url" TEXT NOT NULL,
    "concatenate" TEXT,
    "location_name" TEXT NOT NULL,
    "se_domain" TEXT NOT NULL,
    "language_name" TEXT NOT NULL,
    "status" "RowStatus" NOT NULL DEFAULT 'PENDING',
    "rank_value" INTEGER,
    "rank_display" TEXT,
    "ranking_url" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "last_error_message" TEXT,
    "last_attempt_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranking_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_row_attempts" (
    "id" TEXT NOT NULL,
    "ranking_row_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "request_payload" JSONB NOT NULL,
    "http_status" INTEGER,
    "dataforseo_status_code" INTEGER,
    "dataforseo_status_message" TEXT,
    "raw_response" JSONB,
    "mapped_rank_value" INTEGER,
    "mapped_ranking_url" TEXT,
    "outcome" "AttemptOutcome" NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranking_row_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ranking_rows_last_attempt_id_key" ON "ranking_rows"("last_attempt_id");

-- CreateIndex
CREATE INDEX "ranking_rows_run_id_status_idx" ON "ranking_rows"("run_id", "status");

-- CreateIndex
CREATE INDEX "ranking_rows_row_uid_idx" ON "ranking_rows"("row_uid");

-- CreateIndex
CREATE INDEX "ranking_row_attempts_ranking_row_id_idx" ON "ranking_row_attempts"("ranking_row_id");

-- AddForeignKey
ALTER TABLE "ranking_runs" ADD CONSTRAINT "ranking_runs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_rows" ADD CONSTRAINT "ranking_rows_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ranking_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_rows" ADD CONSTRAINT "ranking_rows_last_attempt_id_fkey" FOREIGN KEY ("last_attempt_id") REFERENCES "ranking_row_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_row_attempts" ADD CONSTRAINT "ranking_row_attempts_ranking_row_id_fkey" FOREIGN KEY ("ranking_row_id") REFERENCES "ranking_rows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
