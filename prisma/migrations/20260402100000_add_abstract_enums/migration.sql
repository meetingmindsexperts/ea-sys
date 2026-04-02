-- Expand PresentationType enum with VIDEO and WORKSHOP
DO $$ BEGIN
    ALTER TYPE "PresentationType" ADD VALUE 'VIDEO';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TYPE "PresentationType" ADD VALUE 'WORKSHOP';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Expand AbstractStatus enum with WITHDRAWN
DO $$ BEGIN
    ALTER TYPE "AbstractStatus" ADD VALUE 'WITHDRAWN';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create RecommendedFormat enum (idempotent via DO block)
DO $$ BEGIN
    CREATE TYPE "RecommendedFormat" AS ENUM ('ORAL', 'POSTER', 'NEITHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
