-- Add UNASSIGNED to PaymentStatus enum.
--
-- Used by admin-created registrations (dashboard "Add" dialog + CSV import)
-- to signal "payment tracking hasn't been set yet" — distinct from UNPAID
-- (which implies the public user owes money and hasn't paid).
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'UNASSIGNED';
