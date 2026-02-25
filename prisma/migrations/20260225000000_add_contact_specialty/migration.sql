-- AlterTable: add specialty column to Contact
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "specialty" TEXT;
