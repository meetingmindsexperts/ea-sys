-- PILOT RLS policy on Event — HARNESS-ONLY, deliberately NOT a prod
-- migration. Real RLS migrations land per-domain in Phase 2
-- (docs/MULTI_TENANCY.md §13); this file exists to prove the transport
-- end-to-end: ALS tenant store → Prisma $extends → SET LOCAL through
-- pgbouncer transaction pooling → the policy filters rows.
--
-- current_setting('app.current_org', true) returns NULL when the GUC was
-- never set on this backend; NULL comparison excludes every row —
-- fail-closed for free.
--
-- Idempotent: safe to re-run.

ALTER TABLE "Event" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_tenant_isolation ON "Event";
CREATE POLICY event_tenant_isolation ON "Event"
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
