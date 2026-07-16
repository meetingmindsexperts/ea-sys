-- Freshsales CSV import (July 16, 2026) — external-system provenance columns.
-- Additive + idempotent. `externalId` is the source record id (the upsert key:
-- re-importing a fresh export converges instead of duplicating); `lastImportedAt`
-- powers the conflict rule (a row edited in EA-SYS after its last import wins
-- over the CSV). Composite uniques tolerate NULLs — rows never imported carry
-- NULL source/id and don't collide.

ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "externalSource" TEXT;
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "CrmCompany" ADD COLUMN IF NOT EXISTS "lastImportedAt" TIMESTAMP(3);

ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "externalSource" TEXT;
ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "lastImportedAt" TIMESTAMP(3);

ALTER TABLE "CrmDeal" ADD COLUMN IF NOT EXISTS "externalSource" TEXT;
ALTER TABLE "CrmDeal" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "CrmDeal" ADD COLUMN IF NOT EXISTS "lastImportedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmCompany_organizationId_externalSource_externalId_key"
  ON "CrmCompany"("organizationId", "externalSource", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmContact_organizationId_externalSource_externalId_key"
  ON "CrmContact"("organizationId", "externalSource", "externalId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDeal_organizationId_externalSource_externalId_key"
  ON "CrmDeal"("organizationId", "externalSource", "externalId");
