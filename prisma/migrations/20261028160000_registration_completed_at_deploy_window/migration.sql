-- Registration.completedAt, second pass (Oct 28, 2026, review MED). The first migration backfilled at
-- migrate time, but prod migrations apply before the blue/green swap, and the old image kept creating
-- self-service registrations without the stamp until the swap. This repeats the same idempotent
-- backfill once the new image (which stamps on create) is live. It only touches rows still NULL.

UPDATE "Registration"
SET "completedAt" = "createdAt"
WHERE "completedAt" IS NULL
  AND "createdSource" IN ('PUBLIC_REGISTER', 'PUBLIC_SUBMITTER', 'PUBLIC_COMPLETION_FORM', 'GROUP_REGISTER', 'SPEAKER_COMPANION');

UPDATE "Registration" r
SET "completedAt" = a."completedAt"
FROM (
  SELECT "entityId", MIN("createdAt") AS "completedAt"
  FROM "AuditLog"
  WHERE "action" = 'COMPLETE_REGISTRATION' AND "entityType" = 'Registration'
  GROUP BY "entityId"
) a
WHERE r."id" = a."entityId" AND r."completedAt" IS NULL;
