-- One DET order per DtcmOrder row (Nov 3, 2026; review of step 3, MED 2):
-- resolving an uncertain purchase by pasting a DET order number must not be
-- able to attach one government ticket to two registrations. NULL orderIds
-- (attempts not yet sold) are distinct in Postgres, so a plain unique index
-- does the job. Additive and idempotent; the table is new in this release,
-- so no existing rows can collide.
CREATE UNIQUE INDEX IF NOT EXISTS "DtcmOrder_environment_orderId_key" ON "DtcmOrder"("environment", "orderId");
