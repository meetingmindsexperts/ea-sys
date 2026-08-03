-- Multi-tenancy Phase 2 — EmailLog + ScheduledEmail sweep (Domain #18).
-- Additive + idempotent (blue-green safe). Both tables already carry an
-- organizationId column (ScheduledEmail non-null + FK'd since birth; EmailLog
-- nullable); this migration only:
--   1. adds the indexable RLS predicate on ScheduledEmail (EmailLog already
--      has @@index([organizationId]));
--   2. backfills EmailLog's derivable NULL-org rows. Historical callers wrote
--      org-NULL rows for org-owned entities (the getEmailLogsFor OR-null
--      fallback exists because of them); under platform RLS those rows would
--      fail-close out of every tenant view, so stamp them wherever the org is
--      provable: the row's event (1-hop), else the owning REGISTRATION /
--      SPEAKER (their swept org columns) or CONTACT (native org). Rows for
--      genuinely org-less entities (USER auth emails to external accounts)
--      deliberately STAY NULL — the asymmetric policy in
--      prisma/rls/emaillog.sql keeps them writable but tenant-invisible.

CREATE INDEX IF NOT EXISTS "ScheduledEmail_organizationId_idx"
  ON "ScheduledEmail"("organizationId");

-- 1-hop: rows tagged with an event inherit the event's org.
UPDATE "EmailLog" e
SET "organizationId" = ev."organizationId"
FROM "Event" ev
WHERE e."organizationId" IS NULL
  AND e."eventId" = ev."id";

-- Entity-derived: REGISTRATION rows via Registration.organizationId
-- (backfilled by the Registration-core sweep, migration 20260728160000).
UPDATE "EmailLog" e
SET "organizationId" = r."organizationId"
FROM "Registration" r
WHERE e."organizationId" IS NULL
  AND e."entityType" = 'REGISTRATION'
  AND e."entityId" = r."id"
  AND r."organizationId" IS NOT NULL;

-- SPEAKER rows via Speaker.organizationId (Speaker sweep).
UPDATE "EmailLog" e
SET "organizationId" = s."organizationId"
FROM "Speaker" s
WHERE e."organizationId" IS NULL
  AND e."entityType" = 'SPEAKER'
  AND e."entityId" = s."id"
  AND s."organizationId" IS NOT NULL;

-- CONTACT rows via Contact.organizationId (native, non-null).
UPDATE "EmailLog" e
SET "organizationId" = c."organizationId"
FROM "Contact" c
WHERE e."organizationId" IS NULL
  AND e."entityType" = 'CONTACT'
  AND e."entityId" = c."id";
