-- CreateTable
CREATE TABLE "client_report_configs" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "report_tone" TEXT NOT NULL,
    "sections_enabled" JSONB NOT NULL,
    "metrics_enabled" JSONB NOT NULL,
    "custom_instructions" TEXT,
    "recipients" JSONB NOT NULL,
    "reporting_frequency" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_report_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_report_configs_client_id_is_active_idx" ON "client_report_configs"("client_id", "is_active");

-- AddForeignKey
ALTER TABLE "client_report_configs" ADD CONSTRAINT "client_report_configs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
