-- Several surveys, Phase 4 (Oct 7, 2026; docs/MULTI_SURVEY_PLAN.md): a survey
-- one person may answer once per day. Additive and idempotent: a new enum
-- value no existing row holds. Blue/green: the old code never writes it and
-- reads no row holding it until an organiser picks the mode in the new UI.
-- Rollback note in docs/ROLLBACK.md (an older image cannot read a Survey row
-- set to ONCE_PER_DAY).
ALTER TYPE "SurveyResponseMode" ADD VALUE IF NOT EXISTS 'ONCE_PER_DAY';
