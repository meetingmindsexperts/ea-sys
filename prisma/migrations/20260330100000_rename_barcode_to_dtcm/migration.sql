-- Rename barcode to dtcmBarcode
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Registration' AND column_name = 'barcode') THEN
    ALTER TABLE "Registration" RENAME COLUMN "barcode" TO "dtcmBarcode";
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

-- Rename index if it exists
DO $$ BEGIN
  ALTER INDEX IF EXISTS "Registration_barcode_key" RENAME TO "Registration_dtcmBarcode_key";
EXCEPTION WHEN others THEN NULL;
END $$;
