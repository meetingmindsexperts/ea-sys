-- Assignment emails are sent by hand (owner, Nov 10, 2026): one email per
-- reviewer listing every assignment not yet emailed. notifiedAt records which.
-- Additive and nullable: an older image ignores the column.
ALTER TABLE "AbstractReviewer" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);

-- Assignments made before this release were emailed automatically. Mark one
-- notified only when that email was actually SENT (a reviewer-assignment log
-- for the reviewer on the abstract's event, at or after the assignment), so a
-- failed send stays pending and can be sent again. Bounded to rows assigned
-- before the release, so a re-run never marks a newer, unsent assignment.
UPDATE "AbstractReviewer" ar
SET "notifiedAt" = ar."assignedAt"
WHERE ar."notifiedAt" IS NULL
  AND ar."assignedAt" < TIMESTAMP '2026-11-11 00:00:00'
  AND EXISTS (
    SELECT 1
    FROM "EmailLog" el
    JOIN "Abstract" a ON a."id" = ar."abstractId"
    WHERE el."eventId" = a."eventId"
      AND el."entityId" = ar."userId"
      AND el."templateSlug" = 'reviewer-assignment'
      AND el."status" = 'SENT'
      AND el."createdAt" >= ar."assignedAt"
  );
