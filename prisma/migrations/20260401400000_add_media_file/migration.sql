-- CreateTable (idempotent: IF NOT EXISTS + individual column adds)
CREATE TABLE IF NOT EXISTS "MediaFile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaFile_pkey" PRIMARY KEY ("id")
);

-- Columns (IF NOT EXISTS for idempotency — CREATE TABLE IF NOT EXISTS is all-or-nothing)
ALTER TABLE "MediaFile" ADD COLUMN IF NOT EXISTS "organizationId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MediaFile" ADD COLUMN IF NOT EXISTS "uploadedById" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MediaFile" ADD COLUMN IF NOT EXISTS "filename" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MediaFile" ADD COLUMN IF NOT EXISTS "url" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MediaFile" ADD COLUMN IF NOT EXISTS "mimeType" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MediaFile" ADD COLUMN IF NOT EXISTS "size" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MediaFile" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Index (use CREATE INDEX IF NOT EXISTS, not ADD CONSTRAINT)
CREATE INDEX IF NOT EXISTS "MediaFile_organizationId_idx" ON "MediaFile"("organizationId");

-- Foreign keys (wrapped in DO block to handle duplicates)
DO $$
BEGIN
    ALTER TABLE "MediaFile" ADD CONSTRAINT "MediaFile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "MediaFile" ADD CONSTRAINT "MediaFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Also add new columns from the member/student fields feature (idempotent)
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "associationName" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "memberId" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "studentId" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "studentIdExpiry" TIMESTAMP(3);

ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "associationName" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "memberId" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "studentId" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "studentIdExpiry" TIMESTAMP(3);
