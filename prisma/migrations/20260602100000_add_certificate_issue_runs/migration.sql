-- Phase C: bulk certificate issuing pipeline.
--
-- Purely additive, blue-green safe:
--   • IssuedCertificate.pdfUrl is nullable (existing rows stay null until
--     re-rendered or until a Phase C run reissues them).
--   • CertIssueRunStatus enum + CertificateIssueRun + CertificateIssueRunItem
--     are entirely new — no existing code path reads/writes them until the
--     /api/cron/certificate-issues worker is enabled.
--
-- The cron worker drains runs through:
--   PENDING → RENDERING → AWAITING_REVIEW → SENDING → COMPLETED
-- (or → FAILED / CANCELLED as terminal). Items track per-recipient progress
-- (renderedAt → issuedCertificateId → emailedAt) so resume-mid-batch and
-- re-issue-failed-only are queries against item state, not side effects.

-- 1) Run-status enum.
CREATE TYPE "CertIssueRunStatus" AS ENUM (
  'PENDING', 'RENDERING', 'AWAITING_REVIEW', 'SENDING', 'COMPLETED', 'FAILED', 'CANCELLED'
);

-- 2) IssuedCertificate gains a pdfUrl column for the rendered file URL.
ALTER TABLE "IssuedCertificate" ADD COLUMN "pdfUrl" TEXT;

-- 3) CertificateIssueRun — one row per operator "Issue all" action.
CREATE TABLE "CertificateIssueRun" (
  "id"                  TEXT NOT NULL,
  "eventId"             TEXT NOT NULL,
  "type"                "CertificateType" NOT NULL,
  "status"              "CertIssueRunStatus" NOT NULL DEFAULT 'PENDING',
  "totalCount"          INTEGER NOT NULL,
  "renderedCount"       INTEGER NOT NULL DEFAULT 0,
  "emailedCount"        INTEGER NOT NULL DEFAULT 0,
  "failedCount"         INTEGER NOT NULL DEFAULT 0,
  "triggeredByUserId"   TEXT NOT NULL,
  "triggeredAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rendererStartedAt"   TIMESTAMP(3),
  "rendererFinishedAt"  TIMESTAMP(3),
  "emailerStartedAt"    TIMESTAMP(3),
  "emailerFinishedAt"   TIMESTAMP(3),
  "lastTickAt"          TIMESTAMP(3),
  "errors"              JSONB,
  "notes"               TEXT,

  CONSTRAINT "CertificateIssueRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CertificateIssueRun_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CertificateIssueRun_triggeredByUserId_fkey"
    FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Read paths: list runs for an event by type+status (dashboard); claim
-- stalled runs (status=RENDERING/SENDING + old lastTickAt).
CREATE INDEX "CertificateIssueRun_eventId_type_status_idx"
  ON "CertificateIssueRun"("eventId", "type", "status");
CREATE INDEX "CertificateIssueRun_status_lastTickAt_idx"
  ON "CertificateIssueRun"("status", "lastTickAt");

-- 4) CertificateIssueRunItem — one row per (run, recipient). The unit of
--    work the cron drains. recipientName/email are snapshotted at run
--    creation so the UI doesn't need to join + we still show the recipient
--    list correctly if the underlying Registration is later cancelled.
CREATE TABLE "CertificateIssueRunItem" (
  "id"                  TEXT NOT NULL,
  "runId"               TEXT NOT NULL,
  "registrationId"      TEXT,
  "speakerId"           TEXT,
  "recipientName"       TEXT NOT NULL,
  "recipientEmail"      TEXT,
  "renderedAt"          TIMESTAMP(3),
  "issuedCertificateId" TEXT,
  "emailedAt"           TIMESTAMP(3),
  "errorPhase"          TEXT,
  "errorMessage"        TEXT,

  CONSTRAINT "CertificateIssueRunItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CertificateIssueRunItem_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "CertificateIssueRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CertificateIssueRunItem_registrationId_fkey"
    FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CertificateIssueRunItem_speakerId_fkey"
    FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CertificateIssueRunItem_issuedCertificateId_fkey"
    FOREIGN KEY ("issuedCertificateId") REFERENCES "IssuedCertificate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CertificateIssueRunItem_issuedCertificateId_key"
  ON "CertificateIssueRunItem"("issuedCertificateId");
-- Prevent same recipient appearing twice in the same run (operator can't
-- accidentally double-list a registration). Two partial-unique indexes
-- because registrationId XOR speakerId is the recipient discriminator.
CREATE UNIQUE INDEX "CertificateIssueRunItem_runId_registrationId_key"
  ON "CertificateIssueRunItem"("runId", "registrationId")
  WHERE "registrationId" IS NOT NULL;
CREATE UNIQUE INDEX "CertificateIssueRunItem_runId_speakerId_key"
  ON "CertificateIssueRunItem"("runId", "speakerId")
  WHERE "speakerId" IS NOT NULL;

-- Read paths the cron worker hits every tick:
--   "next batch to render" — runId match + renderedAt IS NULL
--   "next batch to email" — runId match + issuedCertificateId IS NOT NULL + emailedAt IS NULL
CREATE INDEX "CertificateIssueRunItem_runId_renderedAt_idx"
  ON "CertificateIssueRunItem"("runId", "renderedAt");
CREATE INDEX "CertificateIssueRunItem_runId_emailedAt_idx"
  ON "CertificateIssueRunItem"("runId", "emailedAt");
