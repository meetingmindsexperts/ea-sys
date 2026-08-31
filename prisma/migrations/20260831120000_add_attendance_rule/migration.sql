-- HR: standing attendance rules. One statement instead of one row per person
-- per day.
--
-- WHY, from a measurement rather than a hunch. Of the 386 work-from-home days
-- imported from the workbook, 252 are TWELVE company-wide dates on which 20 to
-- 22 people were all remote together, and 120 more belong to one permanently
-- remote employee. Fourteen days across five people are genuinely one-offs. So
-- 386 stored rows were holding 27 facts.
--
-- FULLY ADDITIVE. One new table and one new enum; nothing existing is altered,
-- so the old container is never surprised during a blue/green swap. Every
-- statement is IF NOT EXISTS or DO-guarded, so a re-run is a no-op.
--
-- A rule stores no derived days. It is read at query time by
-- src/hr/lib/hr-effective-status.ts, which is also what the balance engine
-- resolves through, so the grid and the payroll figure cannot disagree.

DO $$ BEGIN
  CREATE TYPE "AttendanceRuleScope" AS ENUM ('ORG', 'EMPLOYEE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AttendanceRule" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "scope"          "AttendanceRuleScope" NOT NULL,
  "employeeId"     TEXT,
  "leaveCodeId"    TEXT NOT NULL,
  "startDate"      DATE NOT NULL,
  "endDate"        DATE,
  "label"          TEXT NOT NULL,
  "createdById"    TEXT,
  "source"         TEXT NOT NULL DEFAULT 'ui',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AttendanceRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AttendanceRule_organizationId_idx"
  ON "AttendanceRule"("organizationId");
CREATE INDEX IF NOT EXISTS "AttendanceRule_organizationId_startDate_idx"
  ON "AttendanceRule"("organizationId", "startDate");
CREATE INDEX IF NOT EXISTS "AttendanceRule_employeeId_idx"
  ON "AttendanceRule"("employeeId");

DO $$ BEGIN
  ALTER TABLE "AttendanceRule" ADD CONSTRAINT "AttendanceRule_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AttendanceRule" ADD CONSTRAINT "AttendanceRule_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AttendanceRule" ADD CONSTRAINT "AttendanceRule_leaveCodeId_fkey"
    FOREIGN KEY ("leaveCodeId") REFERENCES "LeaveCode"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
