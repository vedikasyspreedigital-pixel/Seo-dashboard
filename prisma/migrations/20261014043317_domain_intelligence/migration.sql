-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "domain_report_task_id" TEXT;

-- CreateTable
CREATE TABLE "domain_reports" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "website_url" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "report_mode" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "files" JSONB NOT NULL,
    "created_by" TEXT,
    "status" TEXT NOT NULL,
    "clickup_task_id" TEXT,
    "error" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_reports_client_id_created_at_idx" ON "domain_reports"("client_id", "created_at");

-- AddForeignKey
ALTER TABLE "domain_reports" ADD CONSTRAINT "domain_reports_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
