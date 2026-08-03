-- Domain #19 (AuditLog) — denormalized tenant key + derivation backfill.
-- Additive + idempotent (blue-green safe): guarded DDL; every backfill UPDATE
-- is predicated on "organizationId" IS NULL so re-runs are no-ops.
--
-- No FK on purpose (sweep convention): the audit trail must keep its org
-- attribution even after the org row is deleted — an FK SetNull would erase
-- the exact column RLS scopes on.
--
-- Backfill sources, strongest first (measured on prod Aug 3 2026 —
-- 1,780 rows: 1,651 via eventId, ~95% of the remainder derivable; the
-- residue is deleted-event orphans + org-null-actor auth rows, which stay
-- NULL honestly):
--   1. eventId 1-hop from Event (the dominant case)
--   2. changes->>'organizationId' (audit-data-transfer + billing-account rows)
--   3. entityId 'org:<id>' prefix (audit-data-transfer org-scoped exports)
--   4. entityType='Organization' → entityId IS the org id
--   5. entityType='User' → User.organizationId (org-bound staff)
--   6. entityType='Contact' → Contact.organizationId
--   7. Crm* entity types → the CRM row's organizationId
--   8. entityType='ScheduledEmail' → ScheduledEmail.organizationId
--   9. entityType='Registration' → Registration.organizationId (heals rows
--      whose event was deleted but whose registration survives)

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

CREATE INDEX IF NOT EXISTS "AuditLog_organizationId_createdAt_idx"
  ON "AuditLog"("organizationId", "createdAt");

-- 1. eventId 1-hop
UPDATE "AuditLog" a
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE a."organizationId" IS NULL
  AND a."eventId" = e.id;

-- 2. changes JSON carries the org (audit-data-transfer / billing-account)
UPDATE "AuditLog" a
SET "organizationId" = a.changes->>'organizationId'
WHERE a."organizationId" IS NULL
  AND a.changes->>'organizationId' IS NOT NULL
  AND a.changes->>'organizationId' <> '';

-- 3. entityId 'org:<id>' prefix
UPDATE "AuditLog" a
SET "organizationId" = substring(a."entityId" from 5)
WHERE a."organizationId" IS NULL
  AND a."entityId" LIKE 'org:%'
  AND length(a."entityId") > 4;

-- 4. Organization-entity rows: entityId IS the org id (verify it exists)
UPDATE "AuditLog" a
SET "organizationId" = o.id
FROM "Organization" o
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'Organization'
  AND a."entityId" = o.id;

-- 5. User-entity rows: the subject user's org (org-bound staff; org-null
--    registrants/reviewers correctly stay NULL)
UPDATE "AuditLog" a
SET "organizationId" = u."organizationId"
FROM "User" u
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'User'
  AND a."entityId" = u.id
  AND u."organizationId" IS NOT NULL;

-- 6. Contact-entity rows
UPDATE "AuditLog" a
SET "organizationId" = c."organizationId"
FROM "Contact" c
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'Contact'
  AND a."entityId" = c.id;

-- 7. CRM entity rows (legacy pre-CrmActivity audits + config-audit helpers)
UPDATE "AuditLog" a
SET "organizationId" = d."organizationId"
FROM "CrmDeal" d
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'CrmDeal'
  AND a."entityId" = d.id;

UPDATE "AuditLog" a
SET "organizationId" = c."organizationId"
FROM "CrmCompany" c
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'CrmCompany'
  AND a."entityId" = c.id;

UPDATE "AuditLog" a
SET "organizationId" = c."organizationId"
FROM "CrmContact" c
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'CrmContact'
  AND a."entityId" = c.id;

UPDATE "AuditLog" a
SET "organizationId" = t."organizationId"
FROM "CrmEmailTemplate" t
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'CrmEmailTemplate'
  AND a."entityId" = t.id;

UPDATE "AuditLog" a
SET "organizationId" = p."organizationId"
FROM "CrmProduct" p
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'CrmProduct'
  AND a."entityId" = p.id;

-- 8. ScheduledEmail-entity rows
UPDATE "AuditLog" a
SET "organizationId" = s."organizationId"
FROM "ScheduledEmail" s
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'ScheduledEmail'
  AND a."entityId" = s.id
  AND s."organizationId" IS NOT NULL;

-- 9. Registration-entity rows whose event was deleted (SetNull orphans) but
--    whose registration row survives with its own org key
UPDATE "AuditLog" a
SET "organizationId" = r."organizationId"
FROM "Registration" r
WHERE a."organizationId" IS NULL
  AND a."entityType" = 'Registration'
  AND a."entityId" = r.id
  AND r."organizationId" IS NOT NULL;
