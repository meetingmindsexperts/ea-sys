-- HR: a per-employee annual entitlement that overrides the standard rule.
--
-- Owner ruling, Aug 31 2026. A leaver's final year is negotiated between the
-- employee and management rather than calculated, so HR needs somewhere to put
-- the agreed number. NULL keeps the existing rule (30 once the first year is
-- complete, 0 before it), so every current balance is unchanged by this.
--
-- FULLY ADDITIVE and nullable: nothing is backfilled, nothing existing moves.
-- DECIMAL, not double precision, because half days must be exact.

ALTER TABLE "Employee"
  ADD COLUMN IF NOT EXISTS "annualEntitlementDays" DECIMAL(5,1);
