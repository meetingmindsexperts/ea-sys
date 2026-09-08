-- Sep 8, 2026: a registration type's seat limit is a hard ceiling over all of
-- its pricing tiers plus staff adds (owner decision, after a 35-seat type sold
-- 107 through a tier whose own limit was empty; the public form never read the
-- type's limit when the type had tiers).
--
-- From this deploy "TicketType"."soldCount" counts EVERY seat held under the
-- type, tier sales included. Before, a public tier sale moved only
-- "PricingTier"."soldCount", so every type counter is recomputed once from the
-- registration rows. Predicate mirrors holdsSeat() + seatCounter() in
-- src/lib/registration-seat.ts: not cancelled, attending in person, not a
-- speaker companion (companions are created uncapped and live on no counter).
-- Tier counters are untouched: they already count exactly their own sales.
--
-- Additive (no schema change), idempotent (a re-run recomputes the same
-- values), blue-green safe: the previous container keeps working against the
-- corrected counters, it simply stops adding tier sales to them for the few
-- seconds until the swap; scripts/reconcile-soldcounts.ts repairs any residue.
UPDATE "TicketType" tt
SET "soldCount" = held.n
FROM (
  SELECT t."id", COUNT(r."id")::int AS n
  FROM "TicketType" t
  LEFT JOIN "Registration" r
    ON r."ticketTypeId" = t."id"
   AND r."status" <> 'CANCELLED'
   AND r."attendanceMode" = 'IN_PERSON'
   AND (r."createdSource" IS NULL OR r."createdSource" <> 'SPEAKER_COMPANION')
  GROUP BY t."id"
) held
WHERE held."id" = tt."id"
  AND tt."soldCount" <> held.n;
