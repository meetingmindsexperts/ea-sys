-- Convert TicketType.category from enum to free-text String (idempotent)

-- Step 1: If the column is still enum-typed, convert to TEXT with human-readable values
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT udt_name INTO col_type
    FROM information_schema.columns
   WHERE table_name = 'TicketType' AND column_name = 'category';

  IF col_type = 'TicketTypeCategory' THEN
    -- Convert enum values to readable strings
    ALTER TABLE "TicketType"
      ALTER COLUMN "category" TYPE TEXT
      USING CASE "category"::text
        WHEN 'EARLY_BIRD' THEN 'Early Bird'
        WHEN 'STANDARD'   THEN 'Standard'
        WHEN 'PRESENTER'  THEN 'Presenter'
        WHEN 'OTHER'      THEN 'Other'
        ELSE 'Standard'
      END;

    -- Update default
    ALTER TABLE "TicketType"
      ALTER COLUMN "category" SET DEFAULT 'Standard';
  END IF;
END $$;

-- Step 2: Drop the enum type if it exists (no longer needed)
DROP TYPE IF EXISTS "TicketTypeCategory";
