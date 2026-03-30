-- Add COMPLIMENTARY to PaymentStatus enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'COMPLIMENTARY'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PaymentStatus')
  ) THEN
    ALTER TYPE "PaymentStatus" ADD VALUE 'COMPLIMENTARY' AFTER 'PAID';
  END IF;
END $$;
