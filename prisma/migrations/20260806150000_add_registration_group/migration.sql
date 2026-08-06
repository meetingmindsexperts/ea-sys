-- Group registration Phase 1 (docs/GROUP_REGISTRATION_PLAN.md) — the
-- RegistrationGroup anchor: a company coordinator registers N people with ONE
-- payer (BillingAccount) and ONE consolidated invoice.
--
-- Additive + idempotent + blue-green safe:
--   * New table + new nullable columns + new enum value — the old container
--     never touches them.
--   * Invoice.registrationId / Payment.registrationId DROP NOT NULL is
--     instant in Postgres and behavior-invisible to the old container: NULL
--     rows can only be minted by NEW code (group invoices/payments), and the
--     old container never queries by groupId, so during the deploy window it
--     simply never sees such a row (none exist until the new code serves).
--   * Re-running every statement is a no-op.

-- 1) The new createdSource value (run outside a tx by the migrate engine).
ALTER TYPE "RegistrationCreatedSource" ADD VALUE IF NOT EXISTS 'GROUP_REGISTER';

-- 2) The group anchor table.
CREATE TABLE IF NOT EXISTS "RegistrationGroup" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "coordinatorUserId" TEXT,
    "coordinatorName" TEXT NOT NULL,
    "coordinatorEmail" TEXT NOT NULL,
    "coordinatorAttending" BOOLEAN NOT NULL DEFAULT true,
    "billingAccountId" TEXT NOT NULL,
    "payerReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RegistrationGroup_eventId_idx"
    ON "RegistrationGroup" ("eventId");
CREATE INDEX IF NOT EXISTS "RegistrationGroup_organizationId_idx"
    ON "RegistrationGroup" ("organizationId");
CREATE INDEX IF NOT EXISTS "RegistrationGroup_coordinatorUserId_idx"
    ON "RegistrationGroup" ("coordinatorUserId");
CREATE INDEX IF NOT EXISTS "RegistrationGroup_billingAccountId_idx"
    ON "RegistrationGroup" ("billingAccountId");

DO $$ BEGIN
  ALTER TABLE "RegistrationGroup"
    ADD CONSTRAINT "RegistrationGroup_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "RegistrationGroup"
    ADD CONSTRAINT "RegistrationGroup_coordinatorUserId_fkey"
    FOREIGN KEY ("coordinatorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Restrict mirrors Registration.billingAccountId: a payer backing a group
-- cannot be hard-deleted (soft-delete via isActive instead).
DO $$ BEGIN
  ALTER TABLE "RegistrationGroup"
    ADD CONSTRAINT "RegistrationGroup_billingAccountId_fkey"
    FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 3) Membership pointer on Registration (SetNull: a member survives group
--    deletion as a normal registration).
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
CREATE INDEX IF NOT EXISTS "Registration_groupId_idx" ON "Registration" ("groupId");

DO $$ BEGIN
  ALTER TABLE "Registration"
    ADD CONSTRAINT "Registration_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "RegistrationGroup"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 4) Invoice: registration becomes optional; group is the alternative anchor
--    (app-level XOR — exactly one of registrationId/groupId set). Cascade
--    mirrors the existing registration→invoice semantics.
ALTER TABLE "Invoice" ALTER COLUMN "registrationId" DROP NOT NULL;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
CREATE INDEX IF NOT EXISTS "Invoice_groupId_idx" ON "Invoice" ("groupId");

DO $$ BEGIN
  ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "RegistrationGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 5) Payment: same shape as Invoice.
ALTER TABLE "Payment" ALTER COLUMN "registrationId" DROP NOT NULL;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
CREATE INDEX IF NOT EXISTS "Payment_groupId_idx" ON "Payment" ("groupId");

DO $$ BEGIN
  ALTER TABLE "Payment"
    ADD CONSTRAINT "Payment_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "RegistrationGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
