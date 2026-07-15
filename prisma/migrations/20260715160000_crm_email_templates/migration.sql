-- Reusable, editable CRM email templates (per-org).
--
-- Additive + idempotent (INC-003 discipline): one new table, no column dropped or
-- made NOT NULL. Existing CRM data is untouched; an org's built-in templates are
-- seeded lazily by the service on first use, not by this migration.

CREATE TABLE IF NOT EXISTS "CrmEmailTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmEmailTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CrmEmailTemplate_organizationId_sortOrder_idx"
    ON "CrmEmailTemplate" ("organizationId", "sortOrder");

DO $$ BEGIN
  ALTER TABLE "CrmEmailTemplate" ADD CONSTRAINT "CrmEmailTemplate_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "CrmEmailTemplate" ADD CONSTRAINT "CrmEmailTemplate_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
