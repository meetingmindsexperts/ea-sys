-- Add coAuthors (JSON array of {name,email,phone,jobTitle,organization,country})
-- to Abstract. Additive + idempotent → blue-green safe.
ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "coAuthors" JSONB;
