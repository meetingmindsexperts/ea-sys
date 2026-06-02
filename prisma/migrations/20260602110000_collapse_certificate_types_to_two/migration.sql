-- Collapse CertificateType enum from 4 values to 2.
--
-- Before: ATTENDANCE / PRESENTER / POSTER / CME
-- After:  ATTENDANCE / APPRECIATION
--
-- Rationale: designers hand the organizer two physical cert PDFs
-- (Attendance + Appreciation); they want to pick text on the cert
-- via {{tokens}}, not pick from four operational types that don't
-- correspond to two designed visuals. PRESENTER + POSTER + CME
-- collapse into APPRECIATION. CME metadata (hours, accrediting
-- bodies) stays on the event row and is consumed via tokens.
--
-- SAFETY: queried prod IssuedCertificate + CertificateIssueRun
-- pre-migration; both are empty (Phase C just shipped 2026-06-02
-- and no certificates have been issued in prod yet). The DELETE
-- statements are belt-and-braces — they're no-ops on prod but
-- protect against an unexpected row.

-- 1. Hard-delete any rows referencing the soon-to-be-dropped enum
--    values. Cascade order: items → runs → counters → certs.
DELETE FROM "CertificateIssueRunItem"
  WHERE "runId" IN (
    SELECT id FROM "CertificateIssueRun"
    WHERE type IN ('PRESENTER', 'POSTER', 'CME')
  );
DELETE FROM "CertificateIssueRun"
  WHERE type IN ('PRESENTER', 'POSTER', 'CME');
DELETE FROM "CertificateSerialCounter"
  WHERE type IN ('PRESENTER', 'POSTER', 'CME');
DELETE FROM "IssuedCertificate"
  WHERE type IN ('PRESENTER', 'POSTER', 'CME');

-- 2. Recreate the enum with the new values. Postgres has no
--    ALTER TYPE DROP VALUE — the canonical rename+swap dance.
ALTER TYPE "CertificateType" RENAME TO "CertificateType_old";

CREATE TYPE "CertificateType" AS ENUM ('ATTENDANCE', 'APPRECIATION');

ALTER TABLE "IssuedCertificate"
  ALTER COLUMN type TYPE "CertificateType"
  USING type::text::"CertificateType";

ALTER TABLE "CertificateIssueRun"
  ALTER COLUMN type TYPE "CertificateType"
  USING type::text::"CertificateType";

ALTER TABLE "CertificateSerialCounter"
  ALTER COLUMN type TYPE "CertificateType"
  USING type::text::"CertificateType";

DROP TYPE "CertificateType_old";
