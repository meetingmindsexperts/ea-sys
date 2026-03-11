-- Add eventIds array to Contact for tracking which events a contact is associated with
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "eventIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
