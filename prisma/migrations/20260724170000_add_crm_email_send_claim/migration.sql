-- Additive + idempotent: persistent double-submit guard for CRM email blasts.
-- One row per (organizationId, dedupHash) claim; a second identical send inside
-- the dedup window is refused. Rows are ephemeral (pruned on each send).
CREATE TABLE IF NOT EXISTS "CrmEmailSendClaim" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "dedupHash"      TEXT NOT NULL,
  "claimedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmEmailSendClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrmEmailSendClaim_organizationId_dedupHash_key"
  ON "CrmEmailSendClaim" ("organizationId", "dedupHash");

CREATE INDEX IF NOT EXISTS "CrmEmailSendClaim_organizationId_claimedAt_idx"
  ON "CrmEmailSendClaim" ("organizationId", "claimedAt");

DO $$ BEGIN
  ALTER TABLE "CrmEmailSendClaim"
    ADD CONSTRAINT "CrmEmailSendClaim_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
