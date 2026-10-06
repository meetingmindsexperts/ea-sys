-- Several surveys per event, step 3 (docs/MULTI_SURVEY_PLAN.md §14).
--
-- One response per registration PER SURVEY instead of one per registration in
-- total, so a person can answer the end-of-webinar survey AND their CME survey.
-- The duplicate gate moves from the global "registrationId" unique to
-- ("surveyId", "dedupKey"); "registrationId" keeps a plain index.
--
-- The CME survey keeps exactly one response per registration: its responses
-- all carry dedupKey = registrationId, so the new unique holds them to one,
-- and the P2002 race gate the submit relies on still fires for it.
--
-- 1. Backfill first: any response written by the step 2 code during its swap
--    window has a surveyId but may lack a dedupKey; any written by the step 1
--    code has neither. Both belong to the event's CME survey (the oldest
--    certificate survey; nothing else was answerable before this release).
-- 2. Add the new unique, then drop the old one, so a gate exists at every
--    moment. Idempotent: IF [NOT] EXISTS throughout.
--
-- Blue/green: the step 2 container still running during the swap writes CME
-- responses WITH surveyId and dedupKey, so it keeps its race gate on the new
-- unique.

UPDATE "SurveyResponse" r
SET "surveyId" = COALESCE(r."surveyId", (
      SELECT s."id" FROM "Survey" s
      WHERE s."eventId" = r."eventId" AND s."gatesCertificates"
      ORDER BY s."createdAt" ASC
      LIMIT 1
    )),
    "dedupKey" = COALESCE(r."dedupKey", r."registrationId")
WHERE r."surveyId" IS NULL OR r."dedupKey" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "SurveyResponse_surveyId_dedupKey_key"
  ON "SurveyResponse"("surveyId", "dedupKey");
CREATE INDEX IF NOT EXISTS "SurveyResponse_registrationId_idx"
  ON "SurveyResponse"("registrationId");
DROP INDEX IF EXISTS "SurveyResponse_registrationId_key";
