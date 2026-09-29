-- Shared registration views (Sep 29, 2026): named, read-only links to a
-- filtered list of an event's registrations for internal staff. Additive and
-- idempotent: one new table, nothing existing touched.
CREATE TABLE IF NOT EXISTS "RegistrationShareLink" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizationId" TEXT,
    "label" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "statuses" TEXT[],
    "fields" TEXT[],
    "ticketTypeIds" TEXT[],
    "sponsorIds" TEXT[],
    "promoCodeIds" TEXT[],
    "includeFaculty" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RegistrationShareLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RegistrationShareLink_token_key" ON "RegistrationShareLink"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "RegistrationShareLink_eventId_label_key" ON "RegistrationShareLink"("eventId", "label");
CREATE INDEX IF NOT EXISTS "RegistrationShareLink_organizationId_idx" ON "RegistrationShareLink"("organizationId");

DO $$ BEGIN
  ALTER TABLE "RegistrationShareLink" ADD CONSTRAINT "RegistrationShareLink_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
