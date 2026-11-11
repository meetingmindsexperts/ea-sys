-- Certificate assignments: who receives a certificate, as rows (Nov 11, 2026).
--
-- Until now a certificate template carried a free-text tag
-- (CertificateTemplate.autoIssueTag) and whoever held the same word on their
-- attendee or speaker row received it. The word had to be spelled the same in
-- two places, it recorded neither who added it nor when, it sat on the
-- attendee and not on the registration, and nothing could report on it:
-- production held 804 registrations tagged for a certificate at finished
-- events with no way to say whether they were owed one.
--
-- This table replaces the tag. One row = one person assigned one template.
--
-- FULLY ADDITIVE AND IDEMPOTENT. One new table; nothing existing is altered,
-- so the old container is never surprised during a blue/green swap, and it
-- goes on reading the tag it always read. Every statement is IF NOT EXISTS or
-- DO-guarded, the backfill ids are derived and the inserts are ON CONFLICT DO
-- NOTHING, so a re-run is a no-op.
--
-- The backfill block is ALSO run after the deploy by
-- scripts/backfill-certificate-assignments.ts, which reads it from this file
-- between the two BACKFILL markers: this migration is applied a few minutes
-- before the new code serves, and a tag added in that window would otherwise
-- never become a row. Keep the markers.

CREATE TABLE IF NOT EXISTS "CertificateAssignment" (
  "id"                    TEXT NOT NULL,
  "eventId"               TEXT NOT NULL,
  "organizationId"        TEXT,
  "certificateTemplateId" TEXT NOT NULL,
  "registrationId"        TEXT,
  "speakerId"             TEXT,
  "source"                TEXT NOT NULL DEFAULT 'MANUAL',
  "assignedByUserId"      TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CertificateAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CertificateAssignment_certificateTemplateId_registrationId_key"
  ON "CertificateAssignment"("certificateTemplateId", "registrationId");
CREATE UNIQUE INDEX IF NOT EXISTS "CertificateAssignment_certificateTemplateId_speakerId_key"
  ON "CertificateAssignment"("certificateTemplateId", "speakerId");
CREATE INDEX IF NOT EXISTS "CertificateAssignment_eventId_idx"
  ON "CertificateAssignment"("eventId");
CREATE INDEX IF NOT EXISTS "CertificateAssignment_registrationId_idx"
  ON "CertificateAssignment"("registrationId");
CREATE INDEX IF NOT EXISTS "CertificateAssignment_speakerId_idx"
  ON "CertificateAssignment"("speakerId");
CREATE INDEX IF NOT EXISTS "CertificateAssignment_organizationId_idx"
  ON "CertificateAssignment"("organizationId");

DO $$ BEGIN
  ALTER TABLE "CertificateAssignment" ADD CONSTRAINT "CertificateAssignment_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CertificateAssignment" ADD CONSTRAINT "CertificateAssignment_certificateTemplateId_fkey"
    FOREIGN KEY ("certificateTemplateId") REFERENCES "CertificateTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CertificateAssignment" ADD CONSTRAINT "CertificateAssignment_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CertificateAssignment" ADD CONSTRAINT "CertificateAssignment_speakerId_fkey"
    FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CertificateAssignment" ADD CONSTRAINT "CertificateAssignment_assignedByUserId_fkey"
    FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- BACKFILL:BEGIN
-- What the tag said, as rows. The match is the one the code made: the
-- template's tag, trimmed, is exactly one of the person's tags (case and all).
-- A cancelled registration is copied too; every reader leaves it out, as the
-- tag readers did, so reinstating it restores what it had.

-- 1. Attendance templates: registrations at the template's event whose
--    attendee carries the tag.
INSERT INTO "CertificateAssignment"
  ("id", "eventId", "organizationId", "certificateTemplateId", "registrationId", "source", "createdAt")
SELECT 'cta_' || md5(t."id" || ':r:' || r."id"), t."eventId",
       COALESCE(t."organizationId", e."organizationId"), t."id", r."id", 'TAG_BACKFILL', CURRENT_TIMESTAMP
FROM "CertificateTemplate" t
JOIN "Event" e ON e."id" = t."eventId"
JOIN "Registration" r ON r."eventId" = t."eventId"
JOIN "Attendee" a ON a."id" = r."attendeeId"
WHERE t."category" = 'ATTENDANCE'
  AND btrim(COALESCE(t."autoIssueTag", ''), E' \t\n\r') <> ''
  AND btrim(t."autoIssueTag", E' \t\n\r') = ANY (a."tags")
ON CONFLICT DO NOTHING;

-- 2. Appreciation templates: speakers at the template's event carrying the tag.
INSERT INTO "CertificateAssignment"
  ("id", "eventId", "organizationId", "certificateTemplateId", "speakerId", "source", "createdAt")
SELECT 'cta_' || md5(t."id" || ':s:' || s."id"), t."eventId",
       COALESCE(t."organizationId", e."organizationId"), t."id", s."id", 'TAG_BACKFILL', CURRENT_TIMESTAMP
FROM "CertificateTemplate" t
JOIN "Event" e ON e."id" = t."eventId"
JOIN "Speaker" s ON s."eventId" = t."eventId"
WHERE t."category" = 'APPRECIATION'
  AND btrim(COALESCE(t."autoIssueTag", ''), E' \t\n\r') <> ''
  AND btrim(t."autoIssueTag", E' \t\n\r') = ANY (s."tags")
ON CONFLICT DO NOTHING;

-- 3. Everyone who already HOLDS a certificate from a template is on its list,
--    tag or no tag (one issued from a person's own sheet before the tag gate,
--    or whose tag was removed since). The list is then never smaller than
--    the certificates it explains. A revoked certificate assigns nobody.
INSERT INTO "CertificateAssignment"
  ("id", "eventId", "organizationId", "certificateTemplateId", "registrationId", "source", "createdAt")
SELECT 'cta_' || md5(t."id" || ':r:' || r."id"), t."eventId",
       COALESCE(t."organizationId", e."organizationId"), t."id", r."id", 'ISSUED_BACKFILL', CURRENT_TIMESTAMP
FROM "IssuedCertificate" ic
JOIN "CertificateTemplate" t ON t."id" = ic."certificateTemplateId"
JOIN "Event" e ON e."id" = t."eventId"
JOIN "Registration" r ON r."id" = ic."registrationId" AND r."eventId" = t."eventId"
WHERE t."category" = 'ATTENDANCE'
  AND ic."revokedAt" IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO "CertificateAssignment"
  ("id", "eventId", "organizationId", "certificateTemplateId", "speakerId", "source", "createdAt")
SELECT 'cta_' || md5(t."id" || ':s:' || s."id"), t."eventId",
       COALESCE(t."organizationId", e."organizationId"), t."id", s."id", 'ISSUED_BACKFILL', CURRENT_TIMESTAMP
FROM "IssuedCertificate" ic
JOIN "CertificateTemplate" t ON t."id" = ic."certificateTemplateId"
JOIN "Event" e ON e."id" = t."eventId"
JOIN "Speaker" s ON s."id" = ic."speakerId" AND s."eventId" = t."eventId"
WHERE t."category" = 'APPRECIATION'
  AND ic."revokedAt" IS NULL
ON CONFLICT DO NOTHING;
-- BACKFILL:END
