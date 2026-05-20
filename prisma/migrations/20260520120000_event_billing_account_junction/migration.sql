-- Per-event payer scoping — junction (associative) table giving a
-- many-to-many between Event and BillingAccount with SHARED IDENTITY.
--
-- Pre-this: BillingAccount was org-scoped and EVERY active payer
-- appeared in EVERY event's picker → overflow when one event has 30
-- payers and another would otherwise see all 30. Post-this: each event
-- has its own attached set of payers; "Cleveland Clinic" linked to
-- events A and B is ONE BillingAccount row referenced by TWO junction
-- rows, so the picker on each event shows it once without duplication.
--
-- Purely additive + the junction starts EMPTY. The previous
-- BillingAccount feature (`20260519120000_add_billing_account`) hasn't
-- been deployed yet, so no existing pairs to backfill — junction-empty
-- = picker-empty per event until organizers explicitly attach payers
-- from Settings → Billing. Blue-green safe (old container ignores the
-- new table; new container only filters when the picker passes
-- `?eventId=`).

CREATE TABLE "EventBillingAccount" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedByUserId" TEXT,
    CONSTRAINT "EventBillingAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventBillingAccount_eventId_billingAccountId_key"
    ON "EventBillingAccount"("eventId", "billingAccountId");
CREATE INDEX "EventBillingAccount_eventId_idx" ON "EventBillingAccount"("eventId");
CREATE INDEX "EventBillingAccount_billingAccountId_idx" ON "EventBillingAccount"("billingAccountId");

ALTER TABLE "EventBillingAccount"
    ADD CONSTRAINT "EventBillingAccount_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventBillingAccount"
    ADD CONSTRAINT "EventBillingAccount_billingAccountId_fkey"
    FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventBillingAccount"
    ADD CONSTRAINT "EventBillingAccount_addedByUserId_fkey"
    FOREIGN KEY ("addedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Defensive backfill: attach every (event, billingAccount) pair that
-- ALREADY has at least one Registration on this event referencing that
-- payer. Empty no-op if the prior BillingAccount migration is freshly
-- deployed (no registrations point at a payer yet); preserves picker
-- accessibility for in-flight assignments if v1 had data when this
-- migration runs. Deterministic id (no random/UUID extension required)
-- and ON CONFLICT DO NOTHING so it's idempotent across reruns.
INSERT INTO "EventBillingAccount" ("id", "eventId", "billingAccountId", "addedAt")
SELECT
    CONCAT('backfill-', "eventId", '-', "billingAccountId"),
    "eventId",
    "billingAccountId",
    CURRENT_TIMESTAMP
FROM "Registration"
WHERE "billingAccountId" IS NOT NULL
GROUP BY "eventId", "billingAccountId"
ON CONFLICT DO NOTHING;
