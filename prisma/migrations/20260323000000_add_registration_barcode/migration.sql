-- Add barcode field to Registration for DTCM barcode import
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "barcode" TEXT;

-- Create unique index for barcode lookups (used in check-in scanning)
CREATE UNIQUE INDEX IF NOT EXISTS "Registration_barcode_key" ON "Registration"("barcode");
