-- DTCM review fixes (Nov 4, 2026; docs/DTCM_ETICKET_PLAN.md, review of steps 0
-- to 5). Additive and idempotent: three nullable or defaulted columns, nothing
-- existing changed. No rollback hazard: an older image never reads them.
--
--   DtcmIssueRun.registrationIds  the confirmed registrations, frozen at start
--   DtcmIssueRun.sections         the confirmed section mapping
--   DtcmOrder.detClientId         the DET client id the ticket was bought with

ALTER TABLE "DtcmIssueRun" ADD COLUMN IF NOT EXISTS "registrationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "DtcmIssueRun" ADD COLUMN IF NOT EXISTS "sections" JSONB;
ALTER TABLE "DtcmOrder" ADD COLUMN IF NOT EXISTS "detClientId" TEXT;
