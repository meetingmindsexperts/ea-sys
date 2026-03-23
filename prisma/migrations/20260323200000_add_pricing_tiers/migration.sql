-- CreateTable: PricingTier
CREATE TABLE IF NOT EXISTS "PricingTier" (
    "id" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "quantity" INTEGER NOT NULL DEFAULT 999999,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "maxPerOrder" INTEGER NOT NULL DEFAULT 10,
    "salesStart" TIMESTAMP(3),
    "salesEnd" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingTier_pkey" PRIMARY KEY ("id")
);

-- Add new columns to TicketType
ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Add pricingTierId to Registration (nullable for backward compat)
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "pricingTierId" TEXT;

-- Indexes (CREATE INDEX IF NOT EXISTS per dual-deploy rules)
CREATE INDEX IF NOT EXISTS "PricingTier_ticketTypeId_idx" ON "PricingTier"("ticketTypeId");
CREATE INDEX IF NOT EXISTS "PricingTier_isActive_idx" ON "PricingTier"("isActive");
CREATE INDEX IF NOT EXISTS "Registration_pricingTierId_idx" ON "Registration"("pricingTierId");

-- Unique constraints (use CREATE UNIQUE INDEX, not ADD CONSTRAINT per db push compat)
CREATE UNIQUE INDEX IF NOT EXISTS "PricingTier_ticketTypeId_name_key" ON "PricingTier"("ticketTypeId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "TicketType_eventId_name_key" ON "TicketType"("eventId", "name");

-- Foreign keys (idempotent with DO block)
DO $$ BEGIN
  ALTER TABLE "PricingTier" ADD CONSTRAINT "PricingTier_ticketTypeId_fkey"
    FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Registration" ADD CONSTRAINT "Registration_pricingTierId_fkey"
    FOREIGN KEY ("pricingTierId") REFERENCES "PricingTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Make TicketType.quantity have a default (for new rows that don't set it)
ALTER TABLE "TicketType" ALTER COLUMN "quantity" SET DEFAULT 999999;
ALTER TABLE "TicketType" ALTER COLUMN "price" SET DEFAULT 0;
