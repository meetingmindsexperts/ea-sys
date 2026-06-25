-- Phase 1 — multi-role certificates.
-- (1) Additive: per-template role label + static CME hours.
ALTER TABLE "CertificateTemplate" ADD COLUMN IF NOT EXISTS "role" TEXT;
ALTER TABLE "CertificateTemplate" ADD COLUMN IF NOT EXISTS "cmeHours" DECIMAL(4,1);

-- (2) Uniqueness swap: one cert per TEMPLATE per recipient (was per type), so a
-- person can hold several role-specific certs (Speaker + Moderator + Committee).
-- Verified collision-free on live data: every existing (event, type, person)
-- holds <=1 cert and a template belongs to one type, so no two certs collide on
-- (event, template, person); null-template legacy certs are distinct under
-- Postgres null semantics. DROP-then-ADD, idempotent guards.
DROP INDEX IF EXISTS "IssuedCertificate_eventId_type_registrationId_key";
DROP INDEX IF EXISTS "IssuedCertificate_eventId_type_speakerId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "IssuedCert_event_template_registration_key"
  ON "IssuedCertificate" ("eventId", "certificateTemplateId", "registrationId");
CREATE UNIQUE INDEX IF NOT EXISTS "IssuedCert_event_template_speaker_key"
  ON "IssuedCertificate" ("eventId", "certificateTemplateId", "speakerId");
