-- Multi-template-per-category (2026-06-02).
--
-- Replace the previous 2-slot JSON at Event.settings.certificateTemplates
-- with a proper table so the organizer can define N Attendance + N
-- Appreciation templates per event (e.g. "Standard Attendance" +
-- "VIP Attendance"; "Speaker Appreciation" + "Chairman Appreciation").
--
-- Eligibility stays category-scoped (one cert per recipient per category
-- per event — IssuedCertificate's existing dual @@unique constraints are
-- unchanged). The template is metadata about which design was used at
-- issue time + the canvas/background pointer for new runs.
--
-- IssuedCertificate.certificateTemplateId + CertificateIssueRun.
-- certificateTemplateId are SetNull-on-delete so the operator can prune
-- unused templates without orphaning historical audit rows. Application-
-- layer DELETE rejects when any IssuedCertificate references the template
-- (the FK is a safety net, the API is the policy).
--
-- The previous JSON at Event.settings.certificateTemplates is left in
-- place but ignored by the new code path. No backfill — prod was probed
-- before this migration and zero IssuedCertificate rows exist, so there's
-- nothing real to lose. If any test event had configured the JSON, the
-- operator re-creates the template via the new CRUD UI.

-- 1. New CertificateTemplate table
CREATE TABLE "CertificateTemplate" (
  "id"               TEXT NOT NULL,
  "eventId"          TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "category"         "CertificateType" NOT NULL,
  "backgroundPdfUrl" TEXT,
  "textBoxes"        JSONB NOT NULL DEFAULT '[]',
  "sortOrder"        INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CertificateTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CertificateTemplate_eventId_category_sortOrder_idx"
  ON "CertificateTemplate"("eventId", "category", "sortOrder");

ALTER TABLE "CertificateTemplate"
  ADD CONSTRAINT "CertificateTemplate_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Add certificateTemplateId to IssuedCertificate (nullable + SetNull)
ALTER TABLE "IssuedCertificate"
  ADD COLUMN "certificateTemplateId" TEXT;

CREATE INDEX "IssuedCertificate_certificateTemplateId_idx"
  ON "IssuedCertificate"("certificateTemplateId");

ALTER TABLE "IssuedCertificate"
  ADD CONSTRAINT "IssuedCertificate_certificateTemplateId_fkey"
  FOREIGN KEY ("certificateTemplateId") REFERENCES "CertificateTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Add certificateTemplateId to CertificateIssueRun (nullable + SetNull)
ALTER TABLE "CertificateIssueRun"
  ADD COLUMN "certificateTemplateId" TEXT;

CREATE INDEX "CertificateIssueRun_certificateTemplateId_idx"
  ON "CertificateIssueRun"("certificateTemplateId");

ALTER TABLE "CertificateIssueRun"
  ADD CONSTRAINT "CertificateIssueRun_certificateTemplateId_fkey"
  FOREIGN KEY ("certificateTemplateId") REFERENCES "CertificateTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
