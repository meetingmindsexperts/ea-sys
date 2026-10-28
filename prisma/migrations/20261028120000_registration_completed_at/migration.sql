-- Registration.completedAt (Oct 28, 2026, docs/ONSITE_DESK_PLAN.md §3.1): when the person's own
-- details were completed. NULL means an organiser-added or imported row still to complete.
--
-- Additive and idempotent: one nullable column guarded by IF NOT EXISTS, and backfills that only
-- touch rows still NULL, so a re-run changes nothing. The container still running the previous image
-- never reads the column. No index: the "Not completed" filter always runs inside one event, which the
-- existing (eventId, ...) indexes already narrow.

ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

-- Self-service rows were complete when they were created.
UPDATE "Registration"
SET "completedAt" = "createdAt"
WHERE "completedAt" IS NULL
  AND "createdSource" IN ('PUBLIC_REGISTER', 'PUBLIC_SUBMITTER', 'PUBLIC_COMPLETION_FORM', 'GROUP_REGISTER', 'SPEAKER_COMPANION');

-- Rows completed through the emailed form: the time of that completion.
UPDATE "Registration" r
SET "completedAt" = a."completedAt"
FROM (
  SELECT "entityId", MIN("createdAt") AS "completedAt"
  FROM "AuditLog"
  WHERE "action" = 'COMPLETE_REGISTRATION' AND "entityType" = 'Registration'
  GROUP BY "entityId"
) a
WHERE r."id" = a."entityId" AND r."completedAt" IS NULL;

-- Rows from before the source was recorded: complete when the person holds their own account.
UPDATE "Registration"
SET "completedAt" = "createdAt"
WHERE "completedAt" IS NULL AND "createdSource" IS NULL AND "userId" IS NOT NULL;
