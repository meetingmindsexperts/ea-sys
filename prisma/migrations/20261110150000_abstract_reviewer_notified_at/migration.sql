-- Assignment emails are sent by hand (owner, Nov 10, 2026): one email per
-- reviewer listing every assignment not yet emailed. notifiedAt records which.
-- Additive and nullable: an older image ignores the column.
ALTER TABLE "AbstractReviewer" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);

-- Assignments made before this release were emailed automatically, at once.
-- Mark one notified only when ITS OWN email was actually sent: a SENT
-- reviewer-assignment log for the reviewer on the abstract's event, written
-- within two minutes after the assignment (production logged them 0.2 to 0.3
-- seconds after; the old code did not retry). The window ties the log to this
-- assignment, so a later email for another abstract cannot cover for one that
-- failed, and a failed send stays pending and can be sent again. A template
-- "Send test" ([TEST] subject) is never an assignment email.
-- Safe to re-run: only rows still null are touched, and an assignment the new
-- code has not emailed has no such log.
UPDATE "AbstractReviewer" ar
SET "notifiedAt" = ar."assignedAt"
WHERE ar."notifiedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "EmailLog" el
    JOIN "Abstract" a ON a."id" = ar."abstractId"
    WHERE el."eventId" = a."eventId"
      AND el."entityType" = 'USER'
      AND el."entityId" = ar."userId"
      AND el."templateSlug" = 'reviewer-assignment'
      AND el."status" = 'SENT'
      AND el."subject" NOT LIKE '[TEST] %'
      AND el."createdAt" >= ar."assignedAt"
      AND el."createdAt" < ar."assignedAt" + INTERVAL '2 minutes'
  );
