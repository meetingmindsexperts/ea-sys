-- Promo code negotiated for a registration group.
--
-- Held on the GROUP because the discount belongs to the deal: when members are
-- added and an unpaid invoice is cancelled and reissued, the reissued invoice
-- must carry the same code. The money lands on Invoice.discountCode /
-- discountAmount (columns that already exist), so each issued document stays a
-- frozen snapshot.
--
-- Additive + idempotent. Nullable, so every existing group is unaffected.
-- ON DELETE SET NULL: removing a promo code must never cascade into a group's
-- registrations; invoices already issued keep their own frozen discount.
ALTER TABLE "RegistrationGroup"
  ADD COLUMN IF NOT EXISTS "promoCodeId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RegistrationGroup_promoCodeId_fkey'
  ) THEN
    ALTER TABLE "RegistrationGroup"
      ADD CONSTRAINT "RegistrationGroup_promoCodeId_fkey"
      FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "RegistrationGroup_promoCodeId_idx"
  ON "RegistrationGroup"("promoCodeId");
