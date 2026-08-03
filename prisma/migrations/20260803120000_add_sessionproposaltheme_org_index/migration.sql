-- Session Proposals sweep (Domain #14): SessionProposal + SessionProposalTheme
-- were BORN with a denormalized nullable organizationId (stamped at create),
-- so this domain needs no org column or backfill. The one gap is the
-- SessionProposalTheme org index — SessionProposal already carries
-- @@index([organizationId]); the theme table did not. Add it so the RLS
-- predicate (organizationId = current_setting('app.current_org')) is indexable,
-- matching every other swept table.
--
-- Additive + idempotent + blue-green safe (index-only; no column, no backfill).
CREATE INDEX IF NOT EXISTS "SessionProposalTheme_organizationId_idx"
  ON "SessionProposalTheme" ("organizationId");
