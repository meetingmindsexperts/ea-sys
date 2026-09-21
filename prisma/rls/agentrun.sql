-- AgentRun + AgentStep (Event Agent stored runs, Sep 21, 2026; born
-- tenancy-compliant on the day the tables were added).
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap, NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role.
-- Fail-closed on an unset GUC.
--
-- Domain notes:
--   - Both tables carry a NOT NULL organizationId (the in-app door requires an
--     org-bound actor, so there is no org-less writer and no NULL carve-out:
--     the policy is the strict flat shape on both halves).
--   - ONE writer, src/lib/agent/run-store.ts, stamps the org on the run and
--     denormalizes it onto every step, and writes inside runWithTenant; its
--     finish() is a compound updateMany({ id, organizationId }) so the org
--     bind is atomic with the write (defence #1, RLS-independent).
--   - Readers: the infra snapshot's agent section (org-scoped reads run in the
--     tenant's lane; the platform operator's totals use dbOperator) and the
--     agent-run-prune job (age-based, across every org, on the privileged
--     lane like the other retention sweeps).
--   - AgentStep -> AgentRun is ON DELETE CASCADE, so the prune deletes runs
--     and Postgres removes their steps.

ALTER TABLE "AgentRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agentrun_tenant_isolation ON "AgentRun";
CREATE POLICY agentrun_tenant_isolation ON "AgentRun"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "AgentStep" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agentstep_tenant_isolation ON "AgentStep";
CREATE POLICY agentstep_tenant_isolation ON "AgentStep"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
