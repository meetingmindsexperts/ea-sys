-- Row-level security for the six tables that carried an event and no
-- organisation (Event RLS step 5, W2-3, Nov 17 2026): EmailTemplate,
-- Notification, EventStats, ImportLog, InvoiceCounter, EventBillingAccount.
--
-- Until this file, each was guarded only by its queries' own filter on the
-- event: nothing at the database stopped one tenant's lane from reading or
-- moving another's invoice counter, email templates or notices. Migration
-- 20261117120000 added a denormalised organizationId to each, backfilled from
-- the row's Event (a Notification with no event takes its recipient's own
-- organisation), and every writer stamps it.
--
-- Flat policy on organizationId, the shape of every tenant table
-- (prisma/rls/contact.sql is the annotated template: why no FORCE, where this
-- runs, the refuse-to-boot tripwire). Applied by the tenancy harness and the
-- platform bootstrap, NEVER by a prisma migration: master's database holds no
-- row security objects.
--
-- No NULL escape. A row with no organisation is visible to no lane. On the
-- platform every row is born stamped; a Notification for a recipient with no
-- organisation and no event is the one row that can lack it, and such an
-- account receives no notices.
--
-- Fails closed: with app.current_org unset, current_setting(..., true) returns
-- NULL and the comparison matches nothing. Idempotent: safe to re-run.

ALTER TABLE "EmailTemplate" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS emailtemplate_tenant_isolation ON "EmailTemplate";
CREATE POLICY emailtemplate_tenant_isolation ON "EmailTemplate"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_tenant_isolation ON "Notification";
CREATE POLICY notification_tenant_isolation ON "Notification"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "EventStats" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eventstats_tenant_isolation ON "EventStats";
CREATE POLICY eventstats_tenant_isolation ON "EventStats"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "ImportLog" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS importlog_tenant_isolation ON "ImportLog";
CREATE POLICY importlog_tenant_isolation ON "ImportLog"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "InvoiceCounter" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoicecounter_tenant_isolation ON "InvoiceCounter";
CREATE POLICY invoicecounter_tenant_isolation ON "InvoiceCounter"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "EventBillingAccount" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eventbillingaccount_tenant_isolation ON "EventBillingAccount";
CREATE POLICY eventbillingaccount_tenant_isolation ON "EventBillingAccount"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
