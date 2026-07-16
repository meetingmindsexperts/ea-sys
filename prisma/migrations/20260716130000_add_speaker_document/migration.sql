-- Per-speaker uploaded documents: the signed agreement copy (one per speaker,
-- app-enforced with a partial-unique backstop below) + arbitrary attachments
-- (bio doc, CV, ...). Additive + idempotent — blue-green safe (old code
-- ignores the new enum + table).

DO $$ BEGIN
  CREATE TYPE "SpeakerDocumentKind" AS ENUM ('SIGNED_AGREEMENT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "SpeakerDocument" (
  "id"           TEXT NOT NULL,
  "speakerId"    TEXT NOT NULL,
  "kind"         "SpeakerDocumentKind" NOT NULL DEFAULT 'OTHER',
  "url"          TEXT NOT NULL,
  "filename"     TEXT NOT NULL,
  "label"        TEXT,
  "mimeType"     TEXT NOT NULL,
  "size"         INTEGER NOT NULL,
  "uploadedById" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpeakerDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SpeakerDocument_speakerId_idx" ON "SpeakerDocument"("speakerId");

-- Backstop for the app-level "one signed agreement per speaker" rule (a new
-- upload replaces the previous row inside a transaction; this catches a race).
-- Partial unique indexes aren't expressible in the Prisma schema, so this
-- lives only in SQL.
CREATE UNIQUE INDEX IF NOT EXISTS "SpeakerDocument_signed_agreement_one_per_speaker"
  ON "SpeakerDocument"("speakerId")
  WHERE "kind" = 'SIGNED_AGREEMENT';

DO $$ BEGIN
  ALTER TABLE "SpeakerDocument" ADD CONSTRAINT "SpeakerDocument_speakerId_fkey" FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "SpeakerDocument" ADD CONSTRAINT "SpeakerDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
