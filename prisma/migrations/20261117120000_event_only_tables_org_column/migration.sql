-- Multi-tenancy: the six tables that carry an event and no organisation
-- (Event RLS step 5, W2-3 of docs/SECURITY_AUDIT_ACTION_PLAN.md, Nov 17 2026):
-- EmailTemplate, Notification, EventStats, ImportLog, InvoiceCounter,
-- EventBillingAccount.
--
-- Additive + idempotent + blue-green safe: a nullable denormalised
-- organizationId (no FK) on each, backfilled from the row's Event. An image
-- from before this migration does not know the column and leaves it NULL on
-- the rows it writes during a deploy; nothing on master reads it, and a row
-- with none is simply stamped by the next backfill (re-run the UPDATEs below).
-- EXPECT a few such rows on master after the deploy that carries this (notices
-- and templates the old image writes between the migration and the swap): the
-- column must be backfilled again before anything ever relies on it there.
-- Writers stamp it from this deploy forward. The row policies
-- (prisma/rls/eventonly.sql) are applied ONLY by the tenancy harness and the
-- platform bootstrap, never here: master's database holds no row security.

-- Fail fast rather than queue live traffic behind this migration while it
-- waits for a table lock (review of 4054ed0e; the same line as
-- 20261116130000). Each ALTER below takes the table's exclusive lock and the
-- file runs as one transaction, so every read of EmailTemplate (every email
-- send) and of Notification (the bell) would queue behind a wait that an
-- hourly backup or one long transaction can make long. A failed migrate deploy
-- leaves the old slot serving: mark it rolled back with `prisma migrate
-- resolve` and run it again.
SET lock_timeout = '10s';

-- ---- columns ----
ALTER TABLE "EmailTemplate"       ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Notification"        ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "EventStats"          ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "ImportLog"           ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "InvoiceCounter"      ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "EventBillingAccount" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ---- backfill: 1-hop from the row's Event ----
UPDATE "EmailTemplate" t
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

UPDATE "EventStats" t
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

UPDATE "ImportLog" t
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

UPDATE "InvoiceCounter" t
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

UPDATE "EventBillingAccount" t
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE t."eventId" = e."id" AND t."organizationId" IS NULL;

-- Notification: its event's organisation when it names an event ...
UPDATE "Notification" n
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE n."eventId" = e."id" AND n."organizationId" IS NULL;

-- ... and for a notice with no event (a sign-up, an invitation accepted), the
-- recipient's own organisation. A recipient with none leaves it NULL.
UPDATE "Notification" n
SET "organizationId" = u."organizationId"
FROM "User" u
WHERE n."userId" = u."id" AND n."eventId" IS NULL AND n."organizationId" IS NULL AND u."organizationId" IS NOT NULL;

-- ---- indexes ----
CREATE INDEX IF NOT EXISTS "EmailTemplate_organizationId_idx"       ON "EmailTemplate"("organizationId");
CREATE INDEX IF NOT EXISTS "Notification_organizationId_idx"        ON "Notification"("organizationId");
CREATE INDEX IF NOT EXISTS "EventStats_organizationId_idx"          ON "EventStats"("organizationId");
CREATE INDEX IF NOT EXISTS "ImportLog_organizationId_idx"           ON "ImportLog"("organizationId");
CREATE INDEX IF NOT EXISTS "InvoiceCounter_organizationId_idx"      ON "InvoiceCounter"("organizationId");
CREATE INDEX IF NOT EXISTS "EventBillingAccount_organizationId_idx" ON "EventBillingAccount"("organizationId");
