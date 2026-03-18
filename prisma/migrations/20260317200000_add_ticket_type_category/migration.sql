-- CreateEnum (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TicketTypeCategory') THEN
    CREATE TYPE "TicketTypeCategory" AS ENUM ('EARLY_BIRD', 'STANDARD', 'PRESENTER', 'OTHER');
  END IF;
END $$;

-- AddColumn (idempotent)
ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "category" "TicketTypeCategory" NOT NULL DEFAULT 'STANDARD';
