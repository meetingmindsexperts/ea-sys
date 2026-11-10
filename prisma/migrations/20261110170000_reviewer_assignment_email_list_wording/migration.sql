-- The assignment email now lists every new assignment for a reviewer in one
-- message (owner, Nov 10, 2026), so the default's single-abstract wording
-- ("the following abstract", "Review Abstract") reads wrong above a list.
-- Every event holds its own copy of the template, seeded from the default at
-- creation, and that copy wins over the default.
--
-- Data only, no schema change. Replaces the exact default sentences and
-- nothing else: wording an organiser changed does not match and is left alone
-- (the subject only when it still equals the default exactly; chr(8212) is the
-- long dash in it, kept out of this file). The new wording uses no token the
-- image live during the deploy does not fill, so both images can send it.
-- Idempotent: the new sentences do not contain the old ones.
UPDATE "EmailTemplate"
SET "subject" = CASE
      WHEN "subject" = 'You''ve been assigned an abstract to review ' || chr(8212) || ' {{eventName}}'
      THEN 'Your abstract review assignment for {{eventName}}'
      ELSE "subject" END,
    "htmlContent" = REPLACE(REPLACE(REPLACE(REPLACE("htmlContent",
      'to review the following abstract for ', 'to review the following for '),
      'to read the abstract and submit your scores and feedback.', 'to read each abstract and submit your scores and feedback.'),
      '>Review Abstract</a>', '>Go to My Reviews</a>'),
      'a conflict of interest with this abstract, please let the event organizer know.', 'a conflict of interest with any abstract listed here, please let the event organizer know.'),
    "textContent" = REPLACE(REPLACE(REPLACE(REPLACE("textContent",
      'to review the following abstract for ', 'to review the following for '),
      'to read the abstract and submit your scores and feedback.', 'to read each abstract and submit your scores and feedback.'),
      'Review Abstract: {{reviewLink}}', 'Go to My Reviews: {{reviewLink}}'),
      'a conflict of interest with this abstract, please let the event organizer know.', 'a conflict of interest with any abstract listed here, please let the event organizer know.'),
    "updatedAt" = NOW()
WHERE "slug" = 'reviewer-assignment'
  AND ("subject" = 'You''ve been assigned an abstract to review ' || chr(8212) || ' {{eventName}}'
    OR strpos("htmlContent", 'to review the following abstract for ') > 0
    OR strpos("htmlContent", 'to read the abstract and submit your scores and feedback.') > 0
    OR strpos("htmlContent", '>Review Abstract</a>') > 0
    OR strpos("htmlContent", 'a conflict of interest with this abstract, please let the event organizer know.') > 0
    OR strpos(COALESCE("textContent", ''), 'to review the following abstract for ') > 0
    OR strpos(COALESCE("textContent", ''), 'to read the abstract and submit your scores and feedback.') > 0
    OR strpos(COALESCE("textContent", ''), 'Review Abstract: {{reviewLink}}') > 0
    OR strpos(COALESCE("textContent", ''), 'a conflict of interest with this abstract, please let the event organizer know.') > 0);
