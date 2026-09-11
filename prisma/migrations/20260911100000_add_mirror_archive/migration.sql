-- DR mirror archive requests (/admin/backups, Sep 11 2026).
--
-- Additive + idempotent. One new enum and one new table, nothing altered or
-- dropped, so it is blue-green safe: the old container never touches it.
-- Operator-global (no organizationId): the mirror is the whole silo's uploads
-- and only the platform operator may request or download an archive.

DO $$ BEGIN
  CREATE TYPE "MirrorArchiveStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "MirrorArchive" (
    "id" TEXT NOT NULL,
    "status" "MirrorArchiveStatus" NOT NULL DEFAULT 'PENDING',
    "prefix" TEXT NOT NULL DEFAULT 'uploads/',
    "requestedById" TEXT,
    "requestedByEmail" TEXT,
    "key" TEXT,
    "fileCount" INTEGER,
    "sizeBytes" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MirrorArchive_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MirrorArchive_status_createdAt_idx"
    ON "MirrorArchive" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "MirrorArchive_createdAt_idx"
    ON "MirrorArchive" ("createdAt");
