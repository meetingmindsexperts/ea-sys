-- Budget & Procurement, Phase 2 slice 2: spend requests route through the
-- approvals primitive under their own subject (Sep 14, 2026).
-- Spec docs/BUDGET_PROCUREMENT_MODULE.html §6, §8; plan docs/BUDGET_PROCUREMENT_BUILD_PLAN.md §6.
--
-- ADDITIVE AND IDEMPOTENT: one enum value. The still-live old container never
-- writes it, and Postgres only refuses ADD VALUE inside a transaction that
-- also USES the value, which this migration does not.
ALTER TYPE "ApprovalSubjectType" ADD VALUE IF NOT EXISTS 'SPEND_REQUEST';
