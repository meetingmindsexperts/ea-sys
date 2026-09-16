-- Custom roles, step 1: the three tables (docs/PROCUREMENT_ROLES_PLAN.md §5).
--
-- Purely ADDITIVE and IDEMPOTENT: three new tables, no column dropped, nothing
-- renamed, no existing row touched. Blue-green safe by construction, because
-- the container running the previous image never reads these tables.
--
-- NOTHING IS SEEDED HERE. The four starter roles (D11/D14) are seeded by the
-- application's seed-once service, the way BudgetCategory already is, so the
-- set is defined in ONE place (src/lib/permissions/catalogue.ts) rather than
-- duplicated into SQL that then drifts from it.
--
-- `permission` is TEXT, not an enum, so adding a capability is a code change
-- rather than a migration. See the model comment for why.

CREATE TABLE IF NOT EXISTS "PermissionSet" (
  "id"             TEXT         NOT NULL,
  "organizationId" TEXT         NOT NULL,
  "name"           TEXT         NOT NULL,
  "description"    TEXT,
  "version"        INTEGER      NOT NULL DEFAULT 1,
  "archivedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PermissionSet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PermissionSetGrant" (
  "id"              TEXT         NOT NULL,
  "organizationId"  TEXT         NOT NULL,
  "permissionSetId" TEXT         NOT NULL,
  "permission"      TEXT         NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PermissionSetGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UserPermissionSet" (
  "id"              TEXT         NOT NULL,
  "organizationId"  TEXT         NOT NULL,
  "userId"          TEXT         NOT NULL,
  "permissionSetId" TEXT         NOT NULL,
  "assignedById"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserPermissionSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PermissionSet_organizationId_name_key"      ON "PermissionSet"("organizationId", "name");
CREATE INDEX        IF NOT EXISTS "PermissionSet_organizationId_idx"           ON "PermissionSet"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "PermissionSetGrant_permissionSetId_permission_key" ON "PermissionSetGrant"("permissionSetId", "permission");
CREATE INDEX        IF NOT EXISTS "PermissionSetGrant_organizationId_idx"      ON "PermissionSetGrant"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "UserPermissionSet_userId_permissionSetId_key" ON "UserPermissionSet"("userId", "permissionSetId");
CREATE INDEX        IF NOT EXISTS "UserPermissionSet_organizationId_idx"       ON "UserPermissionSet"("organizationId");
CREATE INDEX        IF NOT EXISTS "UserPermissionSet_permissionSetId_idx"      ON "UserPermissionSet"("permissionSetId");

-- Foreign keys, each guarded so a re-run is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PermissionSet_organizationId_fkey') THEN
    ALTER TABLE "PermissionSet" ADD CONSTRAINT "PermissionSet_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PermissionSetGrant_organizationId_fkey') THEN
    ALTER TABLE "PermissionSetGrant" ADD CONSTRAINT "PermissionSetGrant_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PermissionSetGrant_permissionSetId_fkey') THEN
    ALTER TABLE "PermissionSetGrant" ADD CONSTRAINT "PermissionSetGrant_permissionSetId_fkey"
      FOREIGN KEY ("permissionSetId") REFERENCES "PermissionSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserPermissionSet_organizationId_fkey') THEN
    ALTER TABLE "UserPermissionSet" ADD CONSTRAINT "UserPermissionSet_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- Cascade on the holder: removing a team member removes their access.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserPermissionSet_userId_fkey') THEN
    ALTER TABLE "UserPermissionSet" ADD CONSTRAINT "UserPermissionSet_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- SetNull on the assigner: the assignment outlives whoever made it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserPermissionSet_assignedById_fkey') THEN
    ALTER TABLE "UserPermissionSet" ADD CONSTRAINT "UserPermissionSet_assignedById_fkey"
      FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserPermissionSet_permissionSetId_fkey') THEN
    ALTER TABLE "UserPermissionSet" ADD CONSTRAINT "UserPermissionSet_permissionSetId_fkey"
      FOREIGN KEY ("permissionSetId") REFERENCES "PermissionSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
