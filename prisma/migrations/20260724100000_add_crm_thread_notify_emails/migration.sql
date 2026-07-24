-- Additive + idempotent: extra addresses to loop in on inbound replies for a
-- CRM email thread (the outbound send's CC + BCC, incl. the sender's own copy).
-- The inbound worker forward-copies replies to these + the deal owner + the
-- partnerships shared mailbox. Safe on the live CRM pipeline (default empty).
ALTER TABLE "CrmEmailThread"
  ADD COLUMN IF NOT EXISTS "notifyEmails" TEXT[] NOT NULL DEFAULT '{}';
