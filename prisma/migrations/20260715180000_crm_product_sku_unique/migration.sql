-- Unique SKU per org on the CRM catalog (review M1): makes the seed idempotent
-- under a concurrent first-load and blocks manual duplicate SKUs.
--
-- Additive + idempotent. `sku` is nullable → Postgres treats multiple NULL-SKU rows
-- as distinct, so manual products without a SKU are unaffected. The unique name
-- matches Prisma's canonical `@@unique([organizationId, sku])` index name.

CREATE UNIQUE INDEX IF NOT EXISTS "CrmProduct_organizationId_sku_key"
    ON "CrmProduct" ("organizationId", "sku");
