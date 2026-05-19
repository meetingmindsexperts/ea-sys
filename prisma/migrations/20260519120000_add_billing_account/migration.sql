-- "Charge to another account" — reusable org-scoped third-party payer.
--
-- Purely additive + every existing Registration defaults to
-- billingAccountId = NULL (self-pay) and attendeeIsGuarantor = false, i.e.
-- today's exact behavior. Blue-green safe: the old container ignores the
-- new column/table entirely; the new container only acts on a payer when
-- one is explicitly set.

CREATE TYPE "BillingAccountType" AS ENUM ('INSTITUTION', 'COMPANY', 'OTHER');

CREATE TABLE "BillingAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "BillingAccountType" NOT NULL DEFAULT 'INSTITUTION',
    "email" TEXT,
    "phone" TEXT,
    "contactName" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zipCode" TEXT,
    "country" TEXT,
    "taxNumber" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingAccount_organizationId_name_key" ON "BillingAccount"("organizationId", "name");
CREATE INDEX "BillingAccount_organizationId_idx" ON "BillingAccount"("organizationId");

ALTER TABLE "BillingAccount"
    ADD CONSTRAINT "BillingAccount_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Registration" ADD COLUMN "billingAccountId" TEXT;
ALTER TABLE "Registration" ADD COLUMN "payerReference" TEXT;
ALTER TABLE "Registration" ADD COLUMN "attendeeIsGuarantor" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Registration_billingAccountId_idx" ON "Registration"("billingAccountId");

-- Restrict: a BillingAccount with linked registrations cannot be hard-
-- deleted (soft-delete via isActive instead), so registrations never
-- silently lose their payer.
ALTER TABLE "Registration"
    ADD CONSTRAINT "Registration_billingAccountId_fkey"
    FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
