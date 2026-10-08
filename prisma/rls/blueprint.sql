-- RLS for the Event Blueprint tables (Oct 8, 2026; docs/EVENT_BLUEPRINT_PLAN.md).
-- Born tenant-correct: every row carries organizationId, stamped from the
-- signed-in user's organisation at write, and every route runs inside
-- runWithTenant. Flat policy, the convention for org-scoped modules.
--
-- Idempotent: safe to re-run. FOR ALL TO PUBLIC written out explicitly.

ALTER TABLE "Blueprint" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blueprint_tenant_isolation ON "Blueprint";
CREATE POLICY blueprint_tenant_isolation ON "Blueprint"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "BlueprintTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blueprinttemplate_tenant_isolation ON "BlueprintTemplate";
CREATE POLICY blueprinttemplate_tenant_isolation ON "BlueprintTemplate"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "BlueprintStatusLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blueprintstatuslog_tenant_isolation ON "BlueprintStatusLog";
CREATE POLICY blueprintstatuslog_tenant_isolation ON "BlueprintStatusLog"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "BlueprintFile" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blueprintfile_tenant_isolation ON "BlueprintFile";
CREATE POLICY blueprintfile_tenant_isolation ON "BlueprintFile"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
