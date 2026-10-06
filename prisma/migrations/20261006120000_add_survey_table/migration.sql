-- Several surveys per event, step 1 (docs/MULTI_SURVEY_PLAN.md §14).
--
-- A survey moves into its own table so an event can run several (first use:
-- the end-of-webinar survey). At most one per event is the certificate survey,
-- the only one that stamps Registration.surveyCompletedAt (which mints CME
-- certificates); that rule lives in the write path, not here.
--
-- FULLY ADDITIVE AND IDEMPOTENT. One new enum, one new table, two nullable
-- columns and an index on SurveyResponse. Nothing existing is altered or read
-- differently: the Event survey columns stay authoritative and the global
-- SurveyResponse.registrationId unique stays until step 3, so the old
-- container is never surprised during a blue/green swap. Every statement is
-- IF NOT EXISTS or DO-guarded and the backfills are ON CONFLICT DO NOTHING /
-- "WHERE surveyId IS NULL", so a re-run is a no-op. Step 2's migration repeats
-- the backfill to catch a survey built on the old screens in between.

DO $$ BEGIN
  CREATE TYPE "SurveyResponseMode" AS ENUM ('ONCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Survey" (
  "id"                TEXT NOT NULL,
  "eventId"           TEXT NOT NULL,
  "organizationId"    TEXT,
  "name"              TEXT NOT NULL,
  "config"            JSONB NOT NULL,
  "introHtml"         TEXT,
  "thankYouHtml"      TEXT,
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"         INTEGER NOT NULL DEFAULT 0,
  "gatesCertificates" BOOLEAN NOT NULL DEFAULT false,
  "responseMode"      "SurveyResponseMode" NOT NULL DEFAULT 'ONCE',
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Survey_eventId_sortOrder_idx" ON "Survey"("eventId", "sortOrder");
CREATE INDEX IF NOT EXISTS "Survey_organizationId_idx" ON "Survey"("organizationId");

DO $$ BEGIN
  ALTER TABLE "Survey" ADD CONSTRAINT "Survey_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "surveyId" TEXT;
ALTER TABLE "SurveyResponse" ADD COLUMN IF NOT EXISTS "dedupKey" TEXT;
CREATE INDEX IF NOT EXISTS "SurveyResponse_surveyId_idx" ON "SurveyResponse"("surveyId");

-- NO ACTION, not CASCADE (owner, Oct 6, 2026): deleting a survey that has
-- answers is refused, so the evidence behind issued CME certificates cannot be
-- wiped by a delete in the builder. NO ACTION (checked at the end of the
-- statement), not RESTRICT (checked at once): an Event or Organization delete
-- cascades to both Survey and SurveyResponse in the same statement and must
-- still succeed whatever order those cascades fire in.
DO $$ BEGIN
  ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_surveyId_fkey"
    FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: each event's existing survey becomes its certificate survey (it is
-- the one auto-issue already reads through surveyCompletedAt). The id is
-- derived from the event, so a re-run inserts nothing new. Only a real
-- question list counts: clearing a survey writes JSON null (Prisma.JsonNull in
-- the event PUT), which IS NOT NULL in SQL, and must not become a certificate
-- survey with no questions (the schema requires at least one question).
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
ON CONFLICT ("id") DO NOTHING;

-- Every existing response belongs to its event's survey; one response per
-- registration, so the dedup key is the registration.
UPDATE "SurveyResponse" r
SET "surveyId" = 'svy_' || md5(r."eventId"),
    "dedupKey" = r."registrationId"
WHERE r."surveyId" IS NULL
  AND EXISTS (SELECT 1 FROM "Survey" s WHERE s."id" = 'svy_' || md5(r."eventId"));
