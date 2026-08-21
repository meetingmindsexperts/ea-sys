-- PLATFORM-ONLY: per-tenant email uniqueness (PLATFORM_DECISIONS item 6).
--
-- WHY THIS IS SQL AND NOT A PRISMA MIGRATION
-- ------------------------------------------
-- Item 6 was decided Aug 21 2026: on the platform, the same email address may
-- exist in two tenants as two independent accounts. The obvious expression of
-- that is `User.organizationId` required plus `@@unique([organizationId, email])`
-- in schema.prisma.
--
-- It cannot go there. Master and the platform run ONE repo and ONE image
-- (MULTI_TENANCY.md §0, guardrail 1), so they share `schema.prisma` and the
-- migration chain. Master holds 113 org-null users — 90% of its user table, and
-- deliberately so under the Aug 6 ruling that external logins carry no org. A
-- migration making the column required would fail `prisma migrate deploy` on
-- master. The two ways around that both break a recorded rule: forking the
-- schema violates the identical-build guardrail, and stamping master's external
-- logins reverses Aug 6.
--
-- So this constraint lives where the RLS policies live: applied by the platform
-- bootstrap and by the isolation harness, never by the migration chain. Master's
-- database never sees it and keeps its global unique index untouched.
--
-- WHY `NULLS NOT DISTINCT` IS LOAD-BEARING
-- ----------------------------------------
-- Postgres treats NULLs as distinct in a unique index by default, so a plain
-- UNIQUE (organizationId, email) over a NULLABLE column enforces NOTHING for
-- org-null rows: (NULL, 'a@b.com') could appear a thousand times. The index
-- would read as protection while providing none — the exact trap recorded in
-- PLATFORM_DECISIONS §6.
--
-- `NULLS NOT DISTINCT` (PG 15+; the harness runs 16, Supabase 17) closes it: an
-- org-less row falls back to GLOBAL email uniqueness rather than to no
-- uniqueness at all. The platform should never have such a row, and if one
-- appears the failure direction is a refused insert rather than a silent
-- duplicate identity.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- Prisma's client still believes `email` is `@unique`, so
-- `user.findUnique({ where: { email } })` keeps compiling and keeps running —
-- it just becomes ambiguous, returning whichever tenant's row the planner
-- reaches first. Dropping the index cannot make that fail loudly. The code half
-- of item 6 (routing every user-by-email lookup through one tenant-aware
-- resolver) is what closes it, and it is NOT optional once this file has run.
--
-- Idempotent: re-running is a no-op. If two rows already share (org, email) the
-- CREATE fails loudly, which is the direction we want.

DROP INDEX IF EXISTS "User_email_key";

CREATE UNIQUE INDEX IF NOT EXISTS "User_organizationId_email_key"
  ON "User" ("organizationId", email)
  NULLS NOT DISTINCT;
