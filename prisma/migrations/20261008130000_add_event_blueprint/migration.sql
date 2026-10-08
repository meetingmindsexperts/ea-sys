-- Event Blueprint (Oct 8, 2026; docs/EVENT_BLUEPRINT_PLAN.md step 2): the
-- intake brief the events team fills in before an event exists. Additive and
-- idempotent: one new enum, four new tables, nothing existing touched. RLS
-- policies are in prisma/rls/blueprint.sql (platform instance only).


DO $$ BEGIN
  CREATE TYPE "BlueprintStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'PLAN_READY', 'BUILDING', 'PREVIEW', 'LIVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Blueprint" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Untitled event',
    "type" TEXT,
    "status" "BlueprintStatus" NOT NULL DEFAULT 'DRAFT',
    "ref" TEXT,
    "readiness" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL DEFAULT '{}',
    "eventId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "editorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Blueprint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BlueprintTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlueprintTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BlueprintStatusLog" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "fromStatus" "BlueprintStatus",
    "toStatus" "BlueprintStatus",
    "readiness" INTEGER,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlueprintStatusLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BlueprintFile" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT,
    "organizationId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "storedPath" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlueprintFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Blueprint_eventId_key" ON "Blueprint"("eventId");

CREATE INDEX IF NOT EXISTS "Blueprint_organizationId_status_idx" ON "Blueprint"("organizationId", "status");

CREATE INDEX IF NOT EXISTS "Blueprint_organizationId_updatedAt_idx" ON "Blueprint"("organizationId", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "Blueprint_organizationId_ref_key" ON "Blueprint"("organizationId", "ref");

CREATE INDEX IF NOT EXISTS "BlueprintTemplate_organizationId_createdAt_idx" ON "BlueprintTemplate"("organizationId", "createdAt");

CREATE INDEX IF NOT EXISTS "BlueprintStatusLog_blueprintId_createdAt_idx" ON "BlueprintStatusLog"("blueprintId", "createdAt");

CREATE INDEX IF NOT EXISTS "BlueprintStatusLog_organizationId_idx" ON "BlueprintStatusLog"("organizationId");

CREATE INDEX IF NOT EXISTS "BlueprintFile_blueprintId_idx" ON "BlueprintFile"("blueprintId");

CREATE INDEX IF NOT EXISTS "BlueprintFile_organizationId_idx" ON "BlueprintFile"("organizationId");

DO $$ BEGIN
  ALTER TABLE "Blueprint" ADD CONSTRAINT "Blueprint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Blueprint" ADD CONSTRAINT "Blueprint_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BlueprintTemplate" ADD CONSTRAINT "BlueprintTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BlueprintStatusLog" ADD CONSTRAINT "BlueprintStatusLog_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "Blueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BlueprintStatusLog" ADD CONSTRAINT "BlueprintStatusLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BlueprintFile" ADD CONSTRAINT "BlueprintFile_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "Blueprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BlueprintFile" ADD CONSTRAINT "BlueprintFile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
