-- Badge-print analytics + audit time-series index.
--
-- (1) Track badge prints on Registration so "badges printed vs registered"
--     and reprint counts are answerable. badgePrintedAt = first print;
--     badgePrintCount bumps on every (re)print. Per-print history lives in
--     AuditLog (action = 'BADGE_PRINTED'). Both additive with safe defaults
--     so existing rows read as "never printed" — blue-green safe.
ALTER TABLE "Registration"
  ADD COLUMN "badgePrintedAt" TIMESTAMP(3),
  ADD COLUMN "badgePrintCount" INTEGER NOT NULL DEFAULT 0;

-- (2) Composite index for analytics histograms — "all CHECK_IN / BADGE_PRINTED
--     actions for an event, bucketed by time" — so time-series queries use an
--     index instead of full-scanning AuditLog.
CREATE INDEX "AuditLog_eventId_action_createdAt_idx"
  ON "AuditLog" ("eventId", "action", "createdAt");
