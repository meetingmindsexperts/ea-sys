-- Comms-log domain (Domain #18) — tenant-isolation policies for EmailLog +
-- ScheduledEmail. Aug 3, 2026.
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role
-- (owners bypass; the harness two-role split is the platform's reference
-- architecture). Fail-closed on an unset GUC.
--
-- Domain notes:
--   - EmailLog's policy is deliberately ASYMMETRIC (owner decision Aug 3,
--     2026: "keep them, hidden"): WITH CHECK admits NULL-org rows so the
--     audit trail for auth emails to org-less accounts (password resets /
--     verifications for external registrants, reviewers, submitters) is never
--     lost — logEmail never throws, so a strict policy would DISCARD those
--     rows silently. USING stays strict, so NULL-org rows are invisible to
--     every tenant lane (platform-operator/owner access only). All
--     org-derivable rows are stamped at the logEmail choke point (explicit
--     context org, else 1-hop from the tagged event) + backfilled by
--     migration 20260803170000, so the NULL residue is only the genuinely
--     org-less class.
--   - ScheduledEmail.organizationId is non-null + FK'd since birth → plain
--     flat policy. The worker's due-row scan + stuck sweep and the
--     email-log-prune job are deliberately ORG-BLIND (the documented
--     cross-sweep worker precondition — the platform runs them on a
--     privileged maintenance lane); per-row processing wraps in the row's
--     own org.

ALTER TABLE "EmailLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS emaillog_tenant_isolation ON "EmailLog";
CREATE POLICY emaillog_tenant_isolation ON "EmailLog"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK (
    "organizationId" IS NULL
    OR "organizationId" = current_setting('app.current_org', true)
  );

ALTER TABLE "ScheduledEmail" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduledemail_tenant_isolation ON "ScheduledEmail";
CREATE POLICY scheduledemail_tenant_isolation ON "ScheduledEmail"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
