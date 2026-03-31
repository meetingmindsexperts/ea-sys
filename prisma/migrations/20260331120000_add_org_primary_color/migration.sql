-- AlterTable: add primary_color to Organization
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "primary_color" TEXT;
