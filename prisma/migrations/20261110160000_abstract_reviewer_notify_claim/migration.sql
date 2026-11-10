-- A short send lease on an assignment (review of 2df0f9e6, Nov 10, 2026): the
-- rows are claimed in one conditional UPDATE just before a reviewer's
-- assignment email goes out, so two overlapping sends (a retry after a gateway
-- timeout, two tabs, two organisers) cannot both email the same assignments.
-- It is NOT a record of sending: notifiedAt stays null until the email is out,
-- so a process killed mid-send leaves the assignment showing as not emailed.
-- Additive and nullable: an older image ignores both columns.
ALTER TABLE "AbstractReviewer" ADD COLUMN IF NOT EXISTS "notifyClaimedAt" TIMESTAMP(3);
ALTER TABLE "AbstractReviewer" ADD COLUMN IF NOT EXISTS "notifyClaimToken" TEXT;
