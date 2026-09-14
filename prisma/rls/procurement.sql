-- Row-Level Security policies: Budget & Procurement module, Phase 1 (Sep 14, 2026).
-- One domain file for the module's tables (Phase 1, the product catalogue, and the Phase 2 purchasing tables), the webinar.sql shape; see contact.sql
-- for the FULL project-wide rationale and employee.sql for why a module that
-- ships dark behind a flag is policied on day one anyway (a flag flips in a
-- deploy, an unpoliced table cannot).
--
--   * applied ONLY by the tenant-isolation harness (tests/tenancy/global-setup.ts
--     reads every prisma/rls/*.sql) + the PLATFORM bootstrap. NEVER a prisma
--     migration: master keeps a database with ZERO RLS objects.
--   * NO FORCE ROW LEVEL SECURITY: enforcement comes from connecting as a
--     NON-owner app role, which is also what leaves the dbOperator lane working.
--   * FLAT policy on the row's own organizationId. Every module table carries
--     the column, stamped by the service, so no join policy is needed even for
--     the three-hop ApprovalStep.
--   * current_setting(..., true) returns NULL rather than erroring when the GUC
--     is unset, so a missing tenant context fail-closes to zero rows.
--
-- The rls-assert.ts boot tripwire self-extends over every policied table via
-- pg_policy, so it covers these with no code change.

ALTER TABLE "BudgetCategory" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budgetcategory_tenant_isolation ON "BudgetCategory";
CREATE POLICY budgetcategory_tenant_isolation ON "BudgetCategory"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "BudgetTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budgettemplate_tenant_isolation ON "BudgetTemplate";
CREATE POLICY budgettemplate_tenant_isolation ON "BudgetTemplate"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "BudgetTemplateLine" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budgettemplateline_tenant_isolation ON "BudgetTemplateLine";
CREATE POLICY budgettemplateline_tenant_isolation ON "BudgetTemplateLine"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "EventBudget" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eventbudget_tenant_isolation ON "EventBudget";
CREATE POLICY eventbudget_tenant_isolation ON "EventBudget"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "BudgetLine" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budgetline_tenant_isolation ON "BudgetLine";
CREATE POLICY budgetline_tenant_isolation ON "BudgetLine"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "ApprovalWorkflowDefinition" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approvalworkflowdefinition_tenant_isolation ON "ApprovalWorkflowDefinition";
CREATE POLICY approvalworkflowdefinition_tenant_isolation ON "ApprovalWorkflowDefinition"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "ApprovalRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approvalrequest_tenant_isolation ON "ApprovalRequest";
CREATE POLICY approvalrequest_tenant_isolation ON "ApprovalRequest"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "ApprovalStep" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approvalstep_tenant_isolation ON "ApprovalStep";
CREATE POLICY approvalstep_tenant_isolation ON "ApprovalStep"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "EventFinancialSummary" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eventfinancialsummary_tenant_isolation ON "EventFinancialSummary";
CREATE POLICY eventfinancialsummary_tenant_isolation ON "EventFinancialSummary"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "BudgetProduct" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budgetproduct_tenant_isolation ON "BudgetProduct";
CREATE POLICY budgetproduct_tenant_isolation ON "BudgetProduct"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_tenant_isolation ON "Supplier";
CREATE POLICY supplier_tenant_isolation ON "Supplier"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SupplierProduct" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplierproduct_tenant_isolation ON "SupplierProduct";
CREATE POLICY supplierproduct_tenant_isolation ON "SupplierProduct"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SpendRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS spendrequest_tenant_isolation ON "SpendRequest";
CREATE POLICY spendrequest_tenant_isolation ON "SpendRequest"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SpendRequestQuote" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS spendrequestquote_tenant_isolation ON "SpendRequestQuote";
CREATE POLICY spendrequestquote_tenant_isolation ON "SpendRequestQuote"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "Commitment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commitment_tenant_isolation ON "Commitment";
CREATE POLICY commitment_tenant_isolation ON "Commitment"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "CommitmentLine" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commitmentline_tenant_isolation ON "CommitmentLine";
CREATE POLICY commitmentline_tenant_isolation ON "CommitmentLine"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "PaymentRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paymentrecord_tenant_isolation ON "PaymentRecord";
CREATE POLICY paymentrecord_tenant_isolation ON "PaymentRecord"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SpendRequestCounter" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS spendrequestcounter_tenant_isolation ON "SpendRequestCounter";
CREATE POLICY spendrequestcounter_tenant_isolation ON "SpendRequestCounter"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "CommitmentCounter" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commitmentcounter_tenant_isolation ON "CommitmentCounter";
CREATE POLICY commitmentcounter_tenant_isolation ON "CommitmentCounter"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
