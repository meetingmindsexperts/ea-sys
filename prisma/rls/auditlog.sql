-- AuditLog domain (Domain #19) — tenant-isolation policy. Aug 3, 2026.
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role
-- (owners bypass; the harness two-role split is the platform's reference
-- architecture). Fail-closed on an unset GUC.
--
-- Domain notes:
--   - `organizationId` is a bare scalar with NO FK (the audit trail must
--     survive org deletion with its attribution intact — the eventId FK's
--     SetNull already demonstrates the failure mode: 17 of prod's 129
--     org-less rows are deleted-event orphans). Stamped centrally by the
--     withAuditOrgStamp client extension in src/lib/db.ts (explicit-in-data →
--     ambient tenant lane → eventId 1-hop) + explicit stamps at the
--     org-scoped writers; history backfilled by migration 20260803180000.
--   - The policy is ASYMMETRIC like EmailLog's (same owner philosophy,
--     "keep them, hidden"): WITH CHECK admits NULL-org rows (org-null actors
--     — registrant/reviewer password flows — legitimately produce
--     unattributable audit rows), USING stays strict so NULL rows are
--     invisible to every tenant lane (platform-operator/owner access only).
--   - ⚠ PLATFORM PRECONDITION (recorded in ROADMAP §"AuditLog sweep —
--     deferred decisions"): ALL 163 AuditLog writers use Prisma `create()`,
--     which emits INSERT..RETURNING — and RETURNING must pass the strict
--     USING (the Domain-#18 discovery). So from an app-role lane with no
--     ambient org, a NULL-org audit write is REJECTED at the DB; every
--     writer is fire-and-forget with a logged catch, so on the platform that
--     row is LOST (logged, never silent). Master (no RLS) is unaffected.
--     The org-null auth-flow audits therefore need either a privileged
--     write lane or acceptance of the loss — an owner decision before the
--     first real platform tenant.
--   - No UPDATE/DELETE exists anywhere in the app for AuditLog (and no prune
--     job) — the policy still covers FOR ALL so a future mutation surface
--     inherits the same isolation.
--   - PROVING WITH CHECK here requires createMany, not create() (RETURNING
--     would also have to pass USING — a create()-based smuggle test cannot
--     distinguish this WITH CHECK from a permissive one); pinned in
--     auditlog-rls.test.ts.

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auditlog_tenant_isolation ON "AuditLog";
CREATE POLICY auditlog_tenant_isolation ON "AuditLog"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK (
    "organizationId" IS NULL
    OR "organizationId" = current_setting('app.current_org', true)
  );
