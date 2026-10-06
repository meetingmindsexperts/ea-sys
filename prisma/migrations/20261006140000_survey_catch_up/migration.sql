-- Several surveys per event, step 2 catch-up (docs/MULTI_SURVEY_PLAN.md §14).
--
-- Step 1 copied each event's survey into "Survey" while the old screens kept
-- writing the Event columns. This brings the copy current at the moment the
-- step 2 code (which reads "Survey") deploys, so nothing built, edited or
-- cleared on the old screens in between is lost:
--   1. an event that gained a survey in between gets its certificate survey;
--   2. an edited survey's questions / intro / thank-you are refreshed;
--   3. a survey CLEARED in between (Event.surveyConfig now JSON null or empty)
--      is closed, never deleted, so its link stops opening it exactly as a
--      cleared survey always did, and any answers it holds stay;
--   4. responses submitted in between are linked to their survey.
-- Only the certificate survey ('svy_' || md5(eventId), the reserved CME slot)
-- is touched; no extra survey exists before step 2. Idempotent: re-running
-- changes nothing further.

INSERT INTO "Survey" (
  "id", "eventId", "organizationId", "name", "config", "introHtml", "thankYouHtml",
  "isActive", "sortOrder", "gatesCertificates", "responseMode", "createdAt", "updatedAt"
)
SELECT
  'svy_' || md5(e."id"), e."id", e."organizationId", 'Post-event survey',
  e."surveyConfig"::jsonb, e."surveyIntroHtml", e."surveyThankYouHtml",
  true, 0, true, 'ONCE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Event" e
WHERE -- CASE, not AND: Postgres may evaluate AND operands in any order, and
  -- jsonb_array_length() raises on a non-array (a cleared survey is JSON null).
  CASE WHEN jsonb_typeof(e."surveyConfig"::jsonb) = 'array'
       THEN jsonb_array_length(e."surveyConfig"::jsonb) > 0 ELSE false END
  -- Never a second CME survey: skip an event whose certificate survey was
  -- created by the new code (a cuid id, not the derived one).
  AND NOT EXISTS (
    SELECT 1 FROM "Survey" c
    WHERE c."eventId" = e."id" AND c."gatesCertificates" AND c."id" <> 'svy_' || md5(e."id")
  )
ON CONFLICT ("id") DO UPDATE SET
  "config"       = EXCLUDED."config",
  "introHtml"    = EXCLUDED."introHtml",
  "thankYouHtml" = EXCLUDED."thankYouHtml",
  "isActive"     = true,
  "updatedAt"    = CURRENT_TIMESTAMP
WHERE "Survey"."config" IS DISTINCT FROM EXCLUDED."config"
   OR "Survey"."introHtml" IS DISTINCT FROM EXCLUDED."introHtml"
   OR "Survey"."thankYouHtml" IS DISTINCT FROM EXCLUDED."thankYouHtml"
   OR "Survey"."isActive" = false;

UPDATE "Survey" s
SET "isActive" = false, "updatedAt" = CURRENT_TIMESTAMP
FROM "Event" e
WHERE s."eventId" = e."id"
  AND s."id" = 'svy_' || md5(e."id")
  AND s."isActive" = true
  AND NOT (
    -- CASE, not AND: Postgres may evaluate AND operands in any order, and
    -- jsonb_array_length() raises on a non-array (a cleared survey is JSON null).
    CASE WHEN jsonb_typeof(e."surveyConfig"::jsonb) = 'array'
         THEN jsonb_array_length(e."surveyConfig"::jsonb) > 0 ELSE false END
  );

UPDATE "SurveyResponse" r
SET "surveyId" = 'svy_' || md5(r."eventId"),
    "dedupKey" = r."registrationId"
WHERE r."surveyId" IS NULL
  AND EXISTS (SELECT 1 FROM "Survey" s WHERE s."id" = 'svy_' || md5(r."eventId"));
