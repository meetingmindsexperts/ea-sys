-- Refund reconciliation check (security action plan W0-2, Nov 6, 2026). READ-ONLY.
--
--   npm run prod:psql -- -f scripts/sql/refund-reconcile-check.sql
--   psql "$DATABASE_URL" -f scripts/sql/refund-reconcile-check.sql     (local copy)
--
-- WHY. The dashboard refund raises Registration.refundedAmount in its booking
-- transaction, BEFORE Stripe is called, but raises Payment.refundedAmount only
-- AFTER Stripe succeeds, outside any transaction, and the charge.refunded webhook
-- decides "already counted" from Payment alone. A webhook landing in between, a
-- failed second write, or a process dying after Stripe each make the webhook book
-- the same refund AGAIN: Registration double-counted, a second credit note, a false
-- "refunded from the Stripe Dashboard" notification. See
-- docs/SECURITY_AUDIT_ACTION_PLAN.md section 2.1.
--
-- THE INVARIANT, per registration:
--   Registration.refundedAmount
--     = sum(Payment.refundedAmount of its payments)          (Stripe, webhook AND manual payments)
--     + sum(SUCCEEDED manual RefundAttempt.amount with no payment)  (unattributed residue)
-- (Corrected Nov 6, 2026: the first version added every manual attempt, which
-- counted a manual payment's refund twice. Since the W0-1 follow-up each
-- payment has its own attempt and the residue has one with no payment; a
-- pre-Nov-6 manual attempt can still carry residue on a payment id.)
-- and the credit notes issued should add up to the same figure.
--
-- Only ids, amounts and statuses come out: no names or emails. A row that
-- shows here is a QUESTION, not a verdict. Refunds made before the per-payment
-- counter existed (July 10, 2026) and before RefundAttempt rows were written
-- show as a gap too; the "first_attempt" and "created" columns tell those apart.
-- Fix nothing from this output directly: each fix is by captured id, approved.

\pset footer off
\echo
\echo '== 1. Registrations whose refund counters disagree (the bug''s fingerprint) =='

WITH pay AS (
  SELECT "registrationId" AS rid,
         sum(amount)           AS paid,
         sum("refundedAmount") AS pay_refunded,
         count(*)              AS payments
  FROM "Payment"
  WHERE "registrationId" IS NOT NULL
  GROUP BY 1
),
att AS (
  SELECT "registrationId" AS rid,
         sum(amount) FILTER (WHERE status = 'SUCCEEDED' AND kind = 'manual' AND "paymentId" IS NULL) AS manual_ok,
         sum(amount) FILTER (WHERE status = 'SUCCEEDED' AND kind = 'stripe') AS stripe_ok,
         count(*)    FILTER (WHERE status IN ('PENDING', 'UNKNOWN'))          AS in_flight,
         count(*)                                                              AS attempts,
         min("createdAt")                                                      AS first_attempt
  FROM "RefundAttempt"
  GROUP BY 1
),
cn AS (
  SELECT "registrationId" AS rid, count(*) AS notes, sum(abs(total)) AS notes_total
  FROM "Invoice"
  WHERE type = 'CREDIT_NOTE' AND "registrationId" IS NOT NULL
  GROUP BY 1
)
SELECT r.id                                         AS registration_id,
       e.slug                                       AS event,
       r."paymentStatus"                            AS pay_status,
       r."refundedAmount"                           AS reg_refunded,
       coalesce(p.pay_refunded, 0)                  AS payment_refunded,
       coalesce(a.manual_ok, 0)                     AS residue_refunded,
       r."refundedAmount" - coalesce(p.pay_refunded, 0) - coalesce(a.manual_ok, 0) AS gap,
       coalesce(p.paid, 0)                          AS paid,
       coalesce(c.notes, 0)                         AS credit_notes,
       coalesce(c.notes_total, 0)                   AS credit_notes_total,
       coalesce(a.attempts, 0)                      AS attempts,
       coalesce(a.in_flight, 0)                     AS in_flight,
       a.first_attempt::date                        AS first_attempt,
       r."createdAt"::date                          AS created
FROM "Registration" r
JOIN "Event" e ON e.id = r."eventId"
LEFT JOIN pay p ON p.rid = r.id
LEFT JOIN att a ON a.rid = r.id
LEFT JOIN cn  c ON c.rid = r.id
WHERE (r."refundedAmount" > 0 OR coalesce(p.pay_refunded, 0) > 0 OR coalesce(c.notes, 0) > 0)
  AND (
       r."refundedAmount" <> coalesce(p.pay_refunded, 0) + coalesce(a.manual_ok, 0)
    OR coalesce(c.notes_total, 0) <> r."refundedAmount"
    OR r."refundedAmount" > coalesce(p.paid, 0)
  )
ORDER BY abs(r."refundedAmount" - coalesce(p.pay_refunded, 0) - coalesce(a.manual_ok, 0)) DESC, r."createdAt";

\echo
\echo '== 2. Payments refunded beyond their own charge =='

SELECT id AS payment_id, "registrationId" AS registration_id, amount, "refundedAmount" AS refunded, status
FROM "Payment"
WHERE "refundedAmount" > amount
ORDER BY "refundedAmount" - amount DESC;

\echo
\echo '== 3. Registrations with more credit notes than refund attempts (a second, unasked-for note) =='

SELECT c."registrationId" AS registration_id,
       count(*)                                   AS credit_notes,
       (SELECT count(*) FROM "RefundAttempt" ra
         WHERE ra."registrationId" = c."registrationId" AND ra.status = 'SUCCEEDED') AS succeeded_attempts,
       string_agg(c."invoiceNumber" || ' ' || abs(c.total)::text, ', ' ORDER BY c."createdAt") AS notes
FROM "Invoice" c
WHERE c.type = 'CREDIT_NOTE' AND c."registrationId" IS NOT NULL
GROUP BY 1
HAVING count(*) > (SELECT count(*) FROM "RefundAttempt" ra
                    WHERE ra."registrationId" = c."registrationId" AND ra.status = 'SUCCEEDED')
ORDER BY 2 DESC;

\echo
\echo '== 4. Refund attempts still PENDING or UNKNOWN (the sweep should have settled these) =='

SELECT id AS attempt_id, "registrationId" AS registration_id, kind, status, amount,
       "stripeRefundId" IS NOT NULL AS has_stripe_id, "createdAt"
FROM "RefundAttempt"
WHERE status IN ('PENDING', 'UNKNOWN')
ORDER BY "createdAt";

\echo
\echo '== 5. Totals, for scale =='

SELECT (SELECT count(*) FROM "Registration" WHERE "refundedAmount" > 0)  AS registrations_with_refunds,
       (SELECT coalesce(sum("refundedAmount"), 0) FROM "Registration")   AS reg_refunded_total,
       (SELECT coalesce(sum("refundedAmount"), 0) FROM "Payment")        AS payment_refunded_total,
       (SELECT coalesce(sum(amount), 0) FROM "RefundAttempt"
         WHERE status = 'SUCCEEDED' AND kind = 'manual' AND "paymentId" IS NULL) AS residue_refunded_total,
       (SELECT count(*) FROM "RefundAttempt")                           AS refund_attempts,
       (SELECT count(*) FROM "Invoice" WHERE type = 'CREDIT_NOTE')      AS credit_notes;
