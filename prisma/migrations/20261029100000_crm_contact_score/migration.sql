-- CRM contact score, stored for server-side sorting (Oct 29, 2026; owner
-- decision, replacing the July 21 "derived on read only" rule for SORTING).
--
-- The list now pages on the server, and a database cannot sort by a value it
-- does not hold. The displayed score is still computed live on read; this
-- column only orders the list. It is kept current by refreshContactScores()
-- (src/crm/services/contact-score-service.ts) on every write that changes a
-- contact's deals, and repaired nightly by the crm-contact-score worker job.
--
-- Additive and idempotent: a column with a default (the container still
-- running the previous image inserts 0 and never reads it), one index, and a
-- backfill that recomputes every row from the same formula, so a re-run only
-- rewrites rows whose score is wrong. Formula (src/crm/lib/contact-score.ts):
-- open deals 30 for the first + 15 each extra, capped at 60; any won deal +40;
-- total capped at 100; archived deals excluded.

ALTER TABLE "CrmContact" ADD COLUMN IF NOT EXISTS "score" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "CrmContact_organizationId_score_idx" ON "CrmContact" ("organizationId", "score");

UPDATE "CrmContact" c
SET "score" = s.score
FROM (
  SELECT
    c2.id,
    LEAST(
      100,
      (CASE
        WHEN COUNT(*) FILTER (WHERE d.status = 'OPEN' AND d."archivedAt" IS NULL) = 0 THEN 0
        ELSE LEAST(60, 30 + 15 * (COUNT(*) FILTER (WHERE d.status = 'OPEN' AND d."archivedAt" IS NULL) - 1))
      END)
      + (CASE WHEN COUNT(*) FILTER (WHERE d.status = 'WON' AND d."archivedAt" IS NULL) > 0 THEN 40 ELSE 0 END)
    )::INTEGER AS score
  FROM "CrmContact" c2
  LEFT JOIN "CrmDealContact" dc ON dc."crmContactId" = c2.id
  LEFT JOIN "CrmDeal" d ON d.id = dc."dealId"
  GROUP BY c2.id
) s
WHERE c.id = s.id AND c."score" IS DISTINCT FROM s.score;
