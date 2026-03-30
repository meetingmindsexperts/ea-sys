DO $$ BEGIN
  ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "registrationConfirmationHtml" TEXT;
EXCEPTION WHEN others THEN NULL;
END $$;
