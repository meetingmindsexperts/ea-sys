-- Row-Level Security policies: session-proposals domain (Phase-2 sweep,
-- Domain #14, August 2026) — SessionProposal + SessionProposalTheme, both
-- 1-hop from Event.
--
-- Unlike most sweeps, these two tables were BORN with a denormalized nullable
-- organizationId (stamped at create, the LoginEvent/HelpChatQuery convention),
-- so this domain added no org column and needs no backfill — only the RLS
-- policies here, the SessionProposalTheme org index (migration
-- 20260803120000; SessionProposal already had one), and the runWithTenant wraps.
--
-- See prisma/rls/contact.sql for the full template rationale (applied by the
-- harness + platform bootstrap ONLY, never a migration; NO FORCE — enforcement
-- is the non-owner app role; fail-closed on an unset GUC).
--
-- Notes specific to this domain:
--   * The submission surface serves org-INDEPENDENT SUBMITTERs (organizationId
--     = null): the proposals list/create/detail + the theme GET are DUAL routes
--     wrapped with the RESOURCE org (event.organizationId — non-null, correct
--     for org-null submitters too), the Abstract dual-route pattern. The theme
--     write routes are org-staff only, wrapped with the SESSION org.
--   * SessionProposalTheme has NO per-org unique field beyond @@unique([eventId,
--     name]) — BOTH orgs can hold a theme on the SAME name, so an unscoped
--     `where:{ name }` returning only the caller's row is what proves scoping
--     (the MediaFile/Certificate-template shared-value shape).
--   * SessionProposal.speakerId → Speaker (swept #9) — the proposals POST reads
--     the speaker inside the same wrap, so it resolves on the tenant lane.
--   * No MCP tools + no cron worker touch these tables (v1 is an organizer inbox).
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "SessionProposal" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessionproposal_tenant_isolation ON "SessionProposal";
CREATE POLICY sessionproposal_tenant_isolation ON "SessionProposal"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SessionProposalTheme" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessionproposaltheme_tenant_isolation ON "SessionProposalTheme";
CREATE POLICY sessionproposaltheme_tenant_isolation ON "SessionProposalTheme"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
