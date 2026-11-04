-- CRM quote → QuickBooks (Nov 4, 2026, review of 4e72284d H2): a send whose
-- answer was lost keeps the quote locked until a later send settles whether
-- the Estimate exists. Additive and idempotent: one defaulted column.
ALTER TABLE "CrmQuote" ADD COLUMN IF NOT EXISTS "qboOutcomeUnknown" BOOLEAN NOT NULL DEFAULT false;
