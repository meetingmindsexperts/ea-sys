-- Certificates v1 — Phase A schema additions.
--
-- Purely additive, blue-green safe:
--   • Event.cmeHours is nullable (events without CME accreditation leave it empty).
--   • Per-event accreditor list lives in Event.settings JSON (no schema column).
--   • New CertificateType enum, IssuedCertificate model, CertificateSerialCounter
--     model — none referenced by existing code paths until Phase C ships, so the
--     old blue container keeps serving traffic correctly during the deploy.
--
-- See docs/CORE_STABILITY.md §"Migration discipline" — destructive operations
-- (DROP / RENAME / SET NOT NULL on existing column / enum value removal) are
-- absent.

-- 1) New enum: certificate type.
CREATE TYPE "CertificateType" AS ENUM ('ATTENDANCE', 'PRESENTER', 'POSTER', 'CME');

-- 2) Event.cmeHours — per-event CME / CPD hours awarded. Read by the CME
--    certificate template. Decimal(4,1) supports fractional hours up to 999.9.
ALTER TABLE "Event"
  ADD COLUMN "cmeHours" DECIMAL(4,1);

-- 3) CertificateSerialCounter — atomic per-(event,type) increment, mirrors
--    RegistrationSerialCounter (added 2026-05-18). Composite PK lets us upsert
--    in a single statement under concurrent issues without P2002 races on
--    IssuedCertificate.serial.
CREATE TABLE "CertificateSerialCounter" (
  "eventId"    TEXT NOT NULL,
  "type"       "CertificateType" NOT NULL,
  "lastSerial" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "CertificateSerialCounter_pkey" PRIMARY KEY ("eventId", "type"),
  CONSTRAINT "CertificateSerialCounter_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 4) IssuedCertificate — audit row + reprint state per issued certificate.
--    recipientSnapshot freezes the recipient's name + affiliation at issue
--    time so reprints months later match the original PDF byte-for-byte even
--    if the underlying Attendee / Speaker / Event drifts. Same fixity strategy
--    as Speaker.agreementTextSnapshot.
CREATE TABLE "IssuedCertificate" (
  "id"                TEXT NOT NULL,
  "eventId"           TEXT NOT NULL,
  "registrationId"    TEXT,
  "speakerId"         TEXT,
  "type"              "CertificateType" NOT NULL,
  "serial"            TEXT NOT NULL,
  "issuedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedByUserId"    TEXT NOT NULL,
  "lastReprintedAt"   TIMESTAMP(3),
  "reprintCount"      INTEGER NOT NULL DEFAULT 0,
  "revokedAt"         TIMESTAMP(3),
  "revocationReason"  TEXT,
  "recipientSnapshot" JSONB NOT NULL,
  "cmeHoursSnapshot"  DECIMAL(4,1),

  CONSTRAINT "IssuedCertificate_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "IssuedCertificate_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssuedCertificate_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "IssuedCertificate_speakerId_fkey"
    FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "IssuedCertificate_issuedByUserId_fkey"
    FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "IssuedCertificate_serial_key"
  ON "IssuedCertificate"("serial");

-- Prevent double-issue of the same type to the same recipient. Two indexes —
-- one for registration recipients, one for speaker recipients — because
-- registrationId and speakerId are mutually exclusive (cert is for either a
-- paying attendee or a presenter/poster faculty member).
CREATE UNIQUE INDEX "IssuedCertificate_eventId_type_registrationId_key"
  ON "IssuedCertificate"("eventId", "type", "registrationId")
  WHERE "registrationId" IS NOT NULL;
CREATE UNIQUE INDEX "IssuedCertificate_eventId_type_speakerId_key"
  ON "IssuedCertificate"("eventId", "type", "speakerId")
  WHERE "speakerId" IS NOT NULL;

-- Read paths: list issued certs for an event by type (Issued tab),
-- and lookup by serial (e.g. operator pastes a serial from a printed cert).
CREATE INDEX "IssuedCertificate_eventId_type_idx"
  ON "IssuedCertificate"("eventId", "type");
CREATE INDEX "IssuedCertificate_serial_idx"
  ON "IssuedCertificate"("serial");
