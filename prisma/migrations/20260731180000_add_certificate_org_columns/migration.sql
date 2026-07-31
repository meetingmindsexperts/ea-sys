-- Multi-tenancy Phase 2 — Certificates domain (Domain #13): CertificateTemplate,
-- IssuedCertificate, CertificateIssueRun, CertificateSerialCounter (1-hop from
-- Event) + CertificateIssueRunItem (2-hop via CertificateIssueRun).
-- CertificateSerialCounter is a composite-PK counter (@@id([eventId, type])) — it
-- gets a FLAT org column for the RegistrationSerialCounter reason: its atomic
-- INSERT…ON CONFLICT upsert against a policy-invisible row would raise a spurious
-- unique violation the app misreads, so the writer stamps a flat column instead.
-- Additive + idempotent + blue-green safe: nullable organizationId (no FK),
-- backfilled from the owning Event in hop order. The flag-gated RLS policy lives
-- in prisma/rls/certificate.sql (harness + platform bootstrap only, never a migration).

-- ---- columns ----
ALTER TABLE "CertificateTemplate"       ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "IssuedCertificate"         ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "CertificateIssueRun"       ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "CertificateSerialCounter"  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "CertificateIssueRunItem"   ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- ---- backfill: 1-hop from Event ----
UPDATE "CertificateTemplate" ct
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE ct."eventId" = e."id" AND ct."organizationId" IS NULL;

UPDATE "IssuedCertificate" ic
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE ic."eventId" = e."id" AND ic."organizationId" IS NULL;

UPDATE "CertificateIssueRun" cir
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE cir."eventId" = e."id" AND cir."organizationId" IS NULL;

UPDATE "CertificateSerialCounter" csc
SET "organizationId" = e."organizationId"
FROM "Event" e
WHERE csc."eventId" = e."id" AND csc."organizationId" IS NULL;

-- ---- backfill: 2-hop via the now-stamped CertificateIssueRun ----
UPDATE "CertificateIssueRunItem" item
SET "organizationId" = run."organizationId"
FROM "CertificateIssueRun" run
WHERE item."runId" = run."id" AND item."organizationId" IS NULL;

-- ---- indexes ----
CREATE INDEX IF NOT EXISTS "CertificateTemplate_organizationId_idx"      ON "CertificateTemplate"("organizationId");
CREATE INDEX IF NOT EXISTS "IssuedCertificate_organizationId_idx"        ON "IssuedCertificate"("organizationId");
CREATE INDEX IF NOT EXISTS "CertificateIssueRun_organizationId_idx"      ON "CertificateIssueRun"("organizationId");
CREATE INDEX IF NOT EXISTS "CertificateSerialCounter_organizationId_idx" ON "CertificateSerialCounter"("organizationId");
CREATE INDEX IF NOT EXISTS "CertificateIssueRunItem_organizationId_idx"  ON "CertificateIssueRunItem"("organizationId");
