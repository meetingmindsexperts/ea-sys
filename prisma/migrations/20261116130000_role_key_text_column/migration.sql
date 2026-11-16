-- Role is stored as text (Nov 16, 2026; docs/ORG_FIELDS_PLAN.md, step 1b,
-- option C of section 4, owner decision D15).
--
-- WHY. An organisation will hold its own Role answers, and its own answers
-- cannot be members of the fixed Postgres list "AttendeeRole" (nine medical
-- values). Specialty never had this problem: it was text from the start.
--
-- WHAT. Each of the four records that hold a person's role (Attendee, Speaker,
-- Contact, AccountProfile) gets a text column "roleKey", backfilled from the
-- enum column "role". In the Prisma schema the NEW column takes the field name
-- `role` and the old one becomes `roleLegacy` (both by @map), so the image built
-- from this commit reads and writes "roleKey" only.
--
-- WHY A TRIGGER. Blue/green: the previous image keeps serving against this
-- schema during the health-check window and for as long as a rollback lasts,
-- and it knows only "role". The trigger keeps the two in step whoever writes:
--   - a write that changes only "role" (the previous image) is copied into
--     "roleKey";
--   - a blank "roleKey" is stored as NULL;
--   - a write that sets "roleKey" (this image) is copied into "role" when the
--     answer is one of the nine, else "role" is emptied, so the previous image
--     reads no role for an organisation's own answer and never fails on it.
-- If both change in one statement, "roleKey" wins.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, a backfill that touches
-- only rows still missing their key, CREATE OR REPLACE for the function and the
-- triggers (Postgres 17). Nothing is dropped or renamed, so the migration gate
-- passes without an acknowledgement. The first trigger in this chain.
--
-- KNOWN LIMIT. A database built by `prisma db push` (the tenancy and DB
-- integration harnesses) has the columns and NOT the trigger. Nothing in this
-- image may rely on the trigger: it reads and writes "roleKey" only. Raw SQL
-- must name the physical column "roleKey".

ALTER TABLE "Attendee"       ADD COLUMN IF NOT EXISTS "roleKey" TEXT;
ALTER TABLE "Speaker"        ADD COLUMN IF NOT EXISTS "roleKey" TEXT;
ALTER TABLE "Contact"        ADD COLUMN IF NOT EXISTS "roleKey" TEXT;
ALTER TABLE "AccountProfile" ADD COLUMN IF NOT EXISTS "roleKey" TEXT;

CREATE OR REPLACE FUNCTION person_role_key_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  key_changed  boolean;
  enum_changed boolean;
BEGIN
  -- An empty or blank key is no answer. The enum column could never hold "",
  -- so nothing may start storing it now ("Not recorded" filters match NULL).
  IF NEW."roleKey" IS NOT NULL AND btrim(NEW."roleKey") = '' THEN
    NEW."roleKey" := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    key_changed  := NEW."roleKey" IS NOT NULL;
    enum_changed := NEW."role" IS NOT NULL;
  ELSE
    key_changed  := NEW."roleKey" IS DISTINCT FROM OLD."roleKey";
    enum_changed := NEW."role" IS DISTINCT FROM OLD."role";
  END IF;

  IF key_changed THEN
    IF NEW."roleKey" IS NOT NULL
       AND NEW."roleKey" = ANY (enum_range(NULL::"AttendeeRole")::text[]) THEN
      NEW."role" := NEW."roleKey"::"AttendeeRole";
    ELSE
      NEW."role" := NULL;
    END IF;
  ELSIF enum_changed THEN
    NEW."roleKey" := NEW."role"::text;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER person_role_key_sync
  BEFORE INSERT OR UPDATE ON "Attendee"
  FOR EACH ROW EXECUTE FUNCTION person_role_key_sync();
CREATE OR REPLACE TRIGGER person_role_key_sync
  BEFORE INSERT OR UPDATE ON "Speaker"
  FOR EACH ROW EXECUTE FUNCTION person_role_key_sync();
CREATE OR REPLACE TRIGGER person_role_key_sync
  BEFORE INSERT OR UPDATE ON "Contact"
  FOR EACH ROW EXECUTE FUNCTION person_role_key_sync();
CREATE OR REPLACE TRIGGER person_role_key_sync
  BEFORE INSERT OR UPDATE ON "AccountProfile"
  FOR EACH ROW EXECUTE FUNCTION person_role_key_sync();

-- Backfill AFTER the triggers exist, so a row the previous image writes while
-- this runs is caught either by the trigger or by this statement. Only rows
-- still missing their key are touched; a re-run is a no-op.
UPDATE "Attendee"       SET "roleKey" = "role"::text WHERE "role" IS NOT NULL AND "roleKey" IS NULL;
UPDATE "Speaker"        SET "roleKey" = "role"::text WHERE "role" IS NOT NULL AND "roleKey" IS NULL;
UPDATE "Contact"        SET "roleKey" = "role"::text WHERE "role" IS NOT NULL AND "roleKey" IS NULL;
UPDATE "AccountProfile" SET "roleKey" = "role"::text WHERE "role" IS NOT NULL AND "roleKey" IS NULL;
