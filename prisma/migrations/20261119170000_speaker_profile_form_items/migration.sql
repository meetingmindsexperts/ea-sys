-- What a speaker's form link asks for, per speaker (owner, Nov 19, 2026).
--
-- The organiser chooses what the speaker form collects: photo, bio, passport
-- copy, cover letter, presentation. The event's default lives in
-- Event.settings.speakerProfile.items (no migration); this column is one
-- speaker's own list when it differs, the way Speaker.reimbursementClaimItems
-- is for reimbursement. NULL means the event default.
--
-- ADDITIVE AND IDEMPOTENT. One nullable column with no default: no rewrite of
-- the table, and an older image never reads or writes it, so a blue/green
-- swap is unaffected. A re-run is a no-op.

SET lock_timeout = '10s';

ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "profileFormItems" JSONB;
