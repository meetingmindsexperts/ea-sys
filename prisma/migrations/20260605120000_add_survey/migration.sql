-- Add per-event post-event feedback survey.
--
-- Three additive changes — every existing event + registration row
-- defaults to NULL / no-rows, so this is deploy-safe alongside the
-- running web + worker containers:
--
--   1. Event.surveyConfig          JSON?     — ordered SurveyQuestion[]
--      (see src/lib/survey/schema.ts for the Zod-validated shape).
--      NULL = no survey configured for the event.
--
--   2. Registration.surveyCompletedAt  TIMESTAMP?  — set by the
--      public POST /api/public/events/[slug]/survey handler on
--      successful submit. Mirrors the existing checkedInAt /
--      badgePrintedAt convention. Used by the reporting view, NOT
--      by the certificate eligibility query (that filter operates
--      on Attendee.tags containing "survey-completed" which the
--      same handler writes — see plan §"How the override works").
--
--   3. SurveyResponse table — one row per submission.
--      registrationId is @unique (1:1 with Registration); a second
--      submit returns 200 no-op via P2002 catch in the route.
--      Cascade-deletes from both Event and Registration so orphan
--      cleanup happens automatically when either parent goes away.

ALTER TABLE "Event"
  ADD COLUMN "surveyConfig" JSONB;

ALTER TABLE "Registration"
  ADD COLUMN "surveyCompletedAt" TIMESTAMP(3);

CREATE TABLE "SurveyResponse" (
  "id"             TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "submittedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipHash"         TEXT,
  "answers"        JSONB NOT NULL,

  CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SurveyResponse_registrationId_key"
  ON "SurveyResponse"("registrationId");

CREATE INDEX "SurveyResponse_eventId_submittedAt_idx"
  ON "SurveyResponse"("eventId", "submittedAt");

ALTER TABLE "SurveyResponse"
  ADD CONSTRAINT "SurveyResponse_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SurveyResponse"
  ADD CONSTRAINT "SurveyResponse_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "Registration"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
