-- HR module: attendance and UAE leave tracking. Plan: docs/HR_MODULE_PLAN.md
--
-- FULLY ADDITIVE. Five new tables and two new enums; nothing existing is
-- altered, so there is no blue/green window in which the old container can be
-- surprised. Every statement is IF NOT EXISTS or DO-guarded, so a re-run is a
-- no-op.
--
-- AVAILABILITY vs TENANCY (owner, Aug 27 2026). The module is MASTER-SILO ONLY,
-- gated by HR_MODULE_ENABLED. The SCHEMA is nonetheless tenant-correct:
-- organizationId on every table, RLS policies in prisma/rls/ from day one. A
-- flag can be flipped later; a tenant-blind data shape cannot be, which is why
-- the shortcut was not taken.
--
-- DATE, not TIMESTAMP, for calendar dates. A leave day is a date, not an
-- instant; giving it a time invites a timezone to change which day it is.
-- DECIMAL, not double precision, for day counts: half days must be exact, and a
-- float sum of thirty 0.5s is not 15.

DO $$ BEGIN
  CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'RESIGNED', 'TERMINATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LeaveCategory" AS ENUM (
    'ANNUAL', 'SICK_FULL', 'SICK_HALF', 'SICK_UNPAID', 'MATERNITY', 'PARENTAL',
    'BEREAVEMENT', 'HAJJ', 'STUDY', 'NATIONAL_SERVICE', 'UNPAID', 'ABSENT',
    'WORK', 'REST', 'PUBLIC_HOLIDAY', 'ON_DUTY', 'COMP_OFF'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Employee" (
  "id"              TEXT NOT NULL,
  "organizationId"  TEXT NOT NULL,
  "empCode"         TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "department"      TEXT,
  "jobTitle"        TEXT,
  "joiningDate"     DATE NOT NULL,
  "exitDate"        DATE,
  "status"          "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
  "carryoverDays"   DECIMAL(5,1) NOT NULL DEFAULT 0,
  "openingSickUsed" DECIMAL(5,1) NOT NULL DEFAULT 0,
  "openingCompOff"  DECIMAL(5,1) NOT NULL DEFAULT 0,
  "userId"          TEXT,
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LeaveCode" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "label"          TEXT NOT NULL,
  "lawReference"   TEXT,
  "paid"           BOOLEAN NOT NULL,
  "dayWeight"      DECIMAL(2,1) NOT NULL,
  "countsAs"       "LeaveCategory" NOT NULL,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LeaveCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AttendanceEntry" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "employeeId"     TEXT NOT NULL,
  "date"           DATE NOT NULL,
  "leaveCodeId"    TEXT NOT NULL,
  "remarks"        TEXT,
  "approvedById"   TEXT,
  "source"         TEXT NOT NULL DEFAULT 'ui',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AttendanceEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LeaveGrant" (
  "id"              TEXT NOT NULL,
  "organizationId"  TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "leaveYear"       INTEGER NOT NULL,
  "entitlementDays" DECIMAL(4,1) NOT NULL,
  "carriedInDays"   DECIMAL(5,1) NOT NULL DEFAULT 0,
  "grantedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeaveGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PublicHoliday" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "date"           DATE NOT NULL,
  "label"          TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("id")
);

-- Uniques. Every business key is scoped to the org, so two tenants may hold the
-- same employee code or the same leave code without colliding. `Employee.userId`
-- is the one GLOBAL unique, and correctly so: a login belongs to one org, so it
-- can back at most one employee anywhere. NULL repeats freely in Postgres, which
-- is what lets the many employees with no login coexist.
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_organizationId_empCode_key" ON "Employee"("organizationId", "empCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_userId_key" ON "Employee"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "LeaveCode_organizationId_code_key" ON "LeaveCode"("organizationId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "AttendanceEntry_organizationId_employeeId_date_key" ON "AttendanceEntry"("organizationId", "employeeId", "date");
CREATE UNIQUE INDEX IF NOT EXISTS "LeaveGrant_organizationId_employeeId_leaveYear_key" ON "LeaveGrant"("organizationId", "employeeId", "leaveYear");
CREATE UNIQUE INDEX IF NOT EXISTS "PublicHoliday_organizationId_date_key" ON "PublicHoliday"("organizationId", "date");

CREATE INDEX IF NOT EXISTS "Employee_organizationId_idx" ON "Employee"("organizationId");
CREATE INDEX IF NOT EXISTS "Employee_organizationId_status_idx" ON "Employee"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "LeaveCode_organizationId_idx" ON "LeaveCode"("organizationId");
CREATE INDEX IF NOT EXISTS "AttendanceEntry_organizationId_idx" ON "AttendanceEntry"("organizationId");
-- The grid reads one employee across a month, and the balance engine reads one
-- employee across a year; both are this index.
CREATE INDEX IF NOT EXISTS "AttendanceEntry_employeeId_date_idx" ON "AttendanceEntry"("employeeId", "date");
-- "who is on leave today", across the whole org.
CREATE INDEX IF NOT EXISTS "AttendanceEntry_organizationId_date_idx" ON "AttendanceEntry"("organizationId", "date");
CREATE INDEX IF NOT EXISTS "LeaveGrant_organizationId_idx" ON "LeaveGrant"("organizationId");
CREATE INDEX IF NOT EXISTS "LeaveGrant_employeeId_idx" ON "LeaveGrant"("employeeId");
CREATE INDEX IF NOT EXISTS "PublicHoliday_organizationId_idx" ON "PublicHoliday"("organizationId");

-- Foreign keys. Org deletion cascades the whole module. Employee deletion
-- cascades its own attendance and grants. LeaveCode does NOT cascade: deleting a
-- code that entries still reference must be refused, because the alternative is
-- silently erasing why somebody was off. `Employee.userId` is SET NULL, so
-- deleting a login leaves the employment record intact, which it must: the
-- record is gratuity evidence and outlives the account.
DO $$ BEGIN
  ALTER TABLE "Employee" ADD CONSTRAINT "Employee_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LeaveCode" ADD CONSTRAINT "LeaveCode_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AttendanceEntry" ADD CONSTRAINT "AttendanceEntry_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AttendanceEntry" ADD CONSTRAINT "AttendanceEntry_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AttendanceEntry" ADD CONSTRAINT "AttendanceEntry_leaveCodeId_fkey"
    FOREIGN KEY ("leaveCodeId") REFERENCES "LeaveCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LeaveGrant" ADD CONSTRAINT "LeaveGrant_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LeaveGrant" ADD CONSTRAINT "LeaveGrant_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PublicHoliday" ADD CONSTRAINT "PublicHoliday_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
