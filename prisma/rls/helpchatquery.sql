-- HelpChatQuery domain (Domain #20 — the FINAL sweep domain). Aug 4, 2026.
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role.
-- Fail-closed on an unset GUC.
--
-- Domain notes:
--   - Born multi-tenant-ready (the LoginEvent convention): organizationId +
--     @@index([organizationId, createdAt]) since creation; the ONE writer
--     (POST /api/help-chat capture) stamps the asker's org and, since this
--     sweep, writes org-bound rows on their tenant lane and org-null rows
--     (REVIEWER/SUBMITTER/REGISTRANT askers) via createMany — create()'s
--     INSERT..RETURNING would be rejected by the strict USING (the
--     Domain-#18/#19 lesson).
--   - The policy is ASYMMETRIC (EmailLog/AuditLog shape): WITH CHECK admits
--     NULL-org rows so an org-less asker's Q&A capture is never lost; USING
--     stays strict so no tenant lane reads them.
--   - ⚠ PLATFORM PRECONDITION (owner decision Aug 4, 2026:
--     operator-global): the ONLY reader — GET /api/help-chat/queries, the
--     SUPER_ADMIN /admin/help-queries view — is deliberately CROSS-TENANT
--     (the captured questions are the platform operator's product signal)
--     and is NOT wrapped in a tenant lane. Under this policy an app-role
--     query there returns zero rows; the platform must serve that route
--     from the privileged maintenance lane (same class as email-log-prune).
--     This policy is the backstop for every OTHER app-lane query. Master
--     (no RLS, single org) is unaffected.

ALTER TABLE "HelpChatQuery" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS helpchatquery_tenant_isolation ON "HelpChatQuery";
CREATE POLICY helpchatquery_tenant_isolation ON "HelpChatQuery"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK (
    "organizationId" IS NULL
    OR "organizationId" = current_setting('app.current_org', true)
  );
