-- Reviewers see only the abstracts assigned to them (owner, Nov 10, 2026).
-- Every event holds its own copy of the "added as a reviewer" email, seeded
-- from the default at creation, and the default's sentence "You can now review
-- the abstracts submitted to this event" is no longer true.
--
-- Data only, no schema change. Replaces that exact default sentence and nothing
-- else: a template whose wording an organiser changed does not match and is
-- left alone. Idempotent: once replaced, the WHERE no longer matches.
UPDATE "EmailTemplate"
SET "htmlContent" = REPLACE("htmlContent",
      'You can now review the abstracts submitted to this event and record your scores and feedback.',
      'The abstracts assigned to you will appear in My Reviews, where you can record your scores and feedback.'),
    "textContent" = REPLACE("textContent",
      'You can now review the abstracts submitted to this event and record your scores and feedback.',
      'The abstracts assigned to you will appear in My Reviews, where you can record your scores and feedback.'),
    "updatedAt" = NOW()
WHERE "slug" = 'reviewer-pool-invitation'
  AND ("htmlContent" LIKE '%You can now review the abstracts submitted to this event and record your scores and feedback.%'
    OR "textContent" LIKE '%You can now review the abstracts submitted to this event and record your scores and feedback.%');
