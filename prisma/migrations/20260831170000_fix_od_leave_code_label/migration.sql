-- The On-Duty label promised something the rule never granted.
--
-- It read "On Duty (weekend or holiday work)", but a comp-off is earned only
-- when BOTH days of one weekend are worked; a public holiday worked earns
-- nothing (owner ruling, Aug 27 2026, reaffirmed Aug 31). The seed is fixed in
-- code, and a seed only reaches NEW organisations, so the existing row keeps
-- the wrong text without this.
--
-- It matters more than it looks: the attendance code picker now lists these
-- labels rather than bare codes, so this sentence is what an operator reads
-- when choosing.
--
-- Guarded on the exact old text, so an organisation that has since written its
-- own wording keeps it. Idempotent: a second run matches nothing.
UPDATE "LeaveCode"
   SET "label" = 'On Duty (weekend work)'
 WHERE "code" = 'OD'
   AND "label" = 'On Duty (weekend or holiday work)';
