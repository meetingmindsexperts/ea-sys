-- Multi-tenancy Phase 0: TenantDomain host→org mapping table.
-- Additive + idempotent (blue-green safe). Rows are seeded operationally via
-- scripts/add-tenant-domain.ts, never here — a data migration would guess
-- wrong on a fresh platform DB.

CREATE TABLE IF NOT EXISTS "TenantDomain" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantDomain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantDomain_domain_key" ON "TenantDomain"("domain");

CREATE INDEX IF NOT EXISTS "TenantDomain_organizationId_idx" ON "TenantDomain"("organizationId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TenantDomain_organizationId_fkey'
  ) THEN
    ALTER TABLE "TenantDomain"
      ADD CONSTRAINT "TenantDomain_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
