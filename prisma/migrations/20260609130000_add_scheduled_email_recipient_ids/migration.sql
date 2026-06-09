-- Add explicitly-selected recipient ids to ScheduledEmail so the immediate
-- bulk-send route can queue "send to selected" sends without losing the
-- selection. Additive + defaulted -> blue-green safe (old code ignores it,
-- existing rows get an empty array = filter-based send).
ALTER TABLE "ScheduledEmail" ADD COLUMN IF NOT EXISTS "recipientIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
