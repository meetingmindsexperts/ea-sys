-- Per-recipient send idempotency for scheduled/bulk email (review H1).
-- Additive + defaulted → blue-green safe (old code ignores the column; new code
-- appends to it per batch and skips already-emailed recipients on a re-run).
ALTER TABLE "ScheduledEmail"
  ADD COLUMN IF NOT EXISTS "emailedKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
