-- Add state and zipCode to Attendee
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "zipCode" TEXT;

-- Add state and zipCode to Speaker
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "Speaker" ADD COLUMN IF NOT EXISTS "zipCode" TEXT;

-- Add state and zipCode to Contact
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "zipCode" TEXT;

-- Add billing fields to Registration
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "taxNumber" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingFirstName" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingLastName" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingEmail" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingPhone" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingAddress" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingCity" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingState" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingZipCode" TEXT;
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "billingCountry" TEXT;
