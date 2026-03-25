-- Create PresentationType enum
DO $$ BEGIN
  CREATE TYPE "PresentationType" AS ENUM ('ORAL', 'POSTER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add presentationType to Abstract
ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "presentationType" "PresentationType";
