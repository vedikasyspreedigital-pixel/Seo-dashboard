-- Report type per client (2026-11-23): normal PDF / consolidated / not confirmed yet.
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_TYPE_UNCONFIRMED';

ALTER TABLE "clients" ADD COLUMN "report_type_confirmed" BOOLEAN NOT NULL DEFAULT false;

-- Clients already on the consolidated report were set up on purpose.
UPDATE "clients" SET "report_type_confirmed" = true WHERE "consolidated_report" = true;
