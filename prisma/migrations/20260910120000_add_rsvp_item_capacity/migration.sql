-- RsvpItem.capacity ("close automatically at N attending", Sep 10, 2026).
-- The Prisma model RsvpItem maps to the physical table "RsvpDinner" (the
-- Aug 14 rename was Prisma-side only, because ALTER TABLE ... RENAME is not
-- blue-green safe). Additive, nullable, idempotent: the old container keeps
-- serving while this applies.
ALTER TABLE "RsvpDinner" ADD COLUMN IF NOT EXISTS "capacity" INTEGER;
