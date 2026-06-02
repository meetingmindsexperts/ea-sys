-- Per-template default cover-email + per-run snapshot (2026-06-02 evening).
--
-- Templates carry an optional emailSubject + emailBody — the organizer
-- sets these once when designing the cert; the Issue dialog pre-fills
-- from these. The run row carries a SNAPSHOT of what the operator
-- confirmed at Issue time, so a later template edit doesn't change
-- emails for an in-flight run.
--
-- Both columns nullable; existing rows survive untouched. New rows
-- (created via the Issue dialog) always populate the run snapshot —
-- the dialog won't let Confirm fire with empty fields.
--
-- emailBody is TEXT (no length cap) — Tiptap HTML can run a few KB
-- on rich templates; the app-level Zod cap is 10000 chars.

ALTER TABLE "CertificateTemplate"
  ADD COLUMN "emailSubject" TEXT,
  ADD COLUMN "emailBody"    TEXT;

ALTER TABLE "CertificateIssueRun"
  ADD COLUMN "emailSubject" TEXT,
  ADD COLUMN "emailBody"    TEXT;
