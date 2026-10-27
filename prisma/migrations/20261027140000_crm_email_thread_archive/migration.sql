-- CRM inbox archive (Oct 27, 2026): a conversation archived from the inbox.
--
-- Additive and idempotent: one nullable column, guarded so a re-run is a no-op.
-- No index: the inbox lists a few hundred threads per organisation through the
-- existing (organizationId, lastMessageAt) index, and the container still
-- running the previous image never reads the column.

ALTER TABLE "CrmEmailThread" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
