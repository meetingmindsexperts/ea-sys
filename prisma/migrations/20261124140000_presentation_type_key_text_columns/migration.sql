-- Presentation types are stored as text (Nov 24, 2026; step 2 of
-- docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md, section 4.2).
--
-- WHY. An organisation will hold its own presentation types (step 3), and its
-- own types cannot be members of the fixed Postgres lists "PresentationType"
-- (five values) and "RecommendedFormat" (five values with NEITHER). The same
-- problem Role had, solved the same way (20261116130000_role_key_text_column).
--
-- WHAT. Three text columns, backfilled from the enum columns beside them:
--   "Abstract"."presentationTypeKey"             <- "presentationType"
--   "Abstract"."requestedPresentationTypeKey"    <- "requestedPresentationType"
--   "AbstractReviewSubmission"."recommendedFormatKey" <- "recommendedFormat"
-- In the Prisma schema each NEW column takes the existing field name (by
-- @map) and the enum column becomes `...Legacy`, so the image built from this
-- commit reads and writes the text columns only.
--
-- WHY A TRIGGER. Blue/green: the previous image keeps serving against this
-- schema during the health-check window and for as long as a rollback lasts,
-- and it knows only the enum columns. The triggers keep each pair in step,
-- whoever writes:
--   - a write that changes only the enum column (the previous image) is copied
--     into the key;
--   - a blank key is stored as NULL;
--   - a write that sets the key (this image) is copied into the enum column
--     when the key is one of the enum's values, else the enum column is
--     emptied, so the previous image reads no type for an organisation's own
--     type and never fails on it.
-- If both change in one statement, the key wins.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, a backfill that touches
-- only rows still missing their key, CREATE OR REPLACE for the functions and
-- the triggers (Postgres 17). Nothing is dropped or renamed, so the migration
-- gate passes without an acknowledgement.
--
-- search_path is pg_catalog FIRST (review of 2729e1de3): the functions run as
-- the writing user, and with public first an object created there could stand
-- in for a built-in operator or enum_range. Role's migration has public first.
--
-- KNOWN LIMIT. A database built by `prisma db push` (the tenancy and DB
-- integration harnesses) has the columns and NOT the triggers. Nothing in this
-- image may rely on the triggers: it reads and writes the key columns only.
-- Raw SQL must name the physical key columns.
--
-- REMOVING IT LATER (the contract step, once no older image can run): drop the
-- triggers and the functions FIRST, then the enum columns. Postgres does not
-- record a function body as depending on a column, so dropping the column
-- first succeeds and then every write to the two tables fails.

-- Fail fast rather than queue live traffic behind this migration while it
-- waits for a table lock (a failed migrate deploy leaves the old slot serving;
-- mark it rolled back with `prisma migrate resolve` and run it again).
SET lock_timeout = '10s';

ALTER TABLE "Abstract"                 ADD COLUMN IF NOT EXISTS "presentationTypeKey" TEXT;
ALTER TABLE "Abstract"                 ADD COLUMN IF NOT EXISTS "requestedPresentationTypeKey" TEXT;
ALTER TABLE "AbstractReviewSubmission" ADD COLUMN IF NOT EXISTS "recommendedFormatKey" TEXT;

-- One pair at a time: the shared rule, so the two tables cannot disagree.
-- Returns the (key, enum value as text) the row should hold.
CREATE OR REPLACE FUNCTION public.enum_key_pair_sync(
  is_insert   boolean,
  new_key     text,
  old_key     text,
  new_enum    text,
  old_enum    text,
  enum_values text[]
) RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  key_changed  boolean;
  enum_changed boolean;
BEGIN
  -- An empty or blank key is no type. The enum column could never hold "".
  IF new_key IS NOT NULL AND new_key ~ '^[[:space:] ]*$' THEN
    new_key := NULL;
  END IF;

  IF is_insert THEN
    key_changed  := new_key IS NOT NULL;
    enum_changed := new_enum IS NOT NULL;
  ELSE
    key_changed  := new_key IS DISTINCT FROM old_key;
    enum_changed := new_enum IS DISTINCT FROM old_enum;
  END IF;

  IF key_changed THEN
    IF new_key IS NOT NULL AND new_key = ANY (enum_values) THEN
      RETURN ARRAY[new_key, new_key];
    END IF;
    RETURN ARRAY[new_key, NULL];
  ELSIF enum_changed THEN
    RETURN ARRAY[new_enum, new_enum];
  END IF;
  RETURN ARRAY[new_key, new_enum];
END;
$$;

CREATE OR REPLACE FUNCTION public.abstract_presentation_type_key_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  is_insert boolean := TG_OP = 'INSERT';
  allowed   text[]  := enum_range(NULL::public."PresentationType")::text[];
  pair      text[];
BEGIN
  pair := public.enum_key_pair_sync(
    is_insert,
    NEW."presentationTypeKey",
    CASE WHEN is_insert THEN NULL ELSE OLD."presentationTypeKey" END,
    NEW."presentationType"::text,
    CASE WHEN is_insert THEN NULL ELSE OLD."presentationType"::text END,
    allowed
  );
  NEW."presentationTypeKey" := pair[1];
  NEW."presentationType" := pair[2]::public."PresentationType";

  pair := public.enum_key_pair_sync(
    is_insert,
    NEW."requestedPresentationTypeKey",
    CASE WHEN is_insert THEN NULL ELSE OLD."requestedPresentationTypeKey" END,
    NEW."requestedPresentationType"::text,
    CASE WHEN is_insert THEN NULL ELSE OLD."requestedPresentationType"::text END,
    allowed
  );
  NEW."requestedPresentationTypeKey" := pair[1];
  NEW."requestedPresentationType" := pair[2]::public."PresentationType";

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_recommended_format_key_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  is_insert boolean := TG_OP = 'INSERT';
  pair      text[];
BEGIN
  pair := public.enum_key_pair_sync(
    is_insert,
    NEW."recommendedFormatKey",
    CASE WHEN is_insert THEN NULL ELSE OLD."recommendedFormatKey" END,
    NEW."recommendedFormat"::text,
    CASE WHEN is_insert THEN NULL ELSE OLD."recommendedFormat"::text END,
    enum_range(NULL::public."RecommendedFormat")::text[]
  );
  NEW."recommendedFormatKey" := pair[1];
  NEW."recommendedFormat" := pair[2]::public."RecommendedFormat";
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER abstract_presentation_type_key_sync
  BEFORE INSERT OR UPDATE OF "presentationType", "presentationTypeKey", "requestedPresentationType", "requestedPresentationTypeKey" ON "Abstract"
  FOR EACH ROW EXECUTE FUNCTION public.abstract_presentation_type_key_sync();
CREATE OR REPLACE TRIGGER review_recommended_format_key_sync
  BEFORE INSERT OR UPDATE OF "recommendedFormat", "recommendedFormatKey" ON "AbstractReviewSubmission"
  FOR EACH ROW EXECUTE FUNCTION public.review_recommended_format_key_sync();

-- Backfill AFTER the triggers exist, so a row the previous image writes while
-- this runs is caught either by the trigger or by this statement. Only rows
-- still missing their key are touched; a re-run is a no-op.
UPDATE "Abstract" SET "presentationTypeKey" = "presentationType"::text
  WHERE "presentationType" IS NOT NULL AND "presentationTypeKey" IS NULL;
UPDATE "Abstract" SET "requestedPresentationTypeKey" = "requestedPresentationType"::text
  WHERE "requestedPresentationType" IS NOT NULL AND "requestedPresentationTypeKey" IS NULL;
UPDATE "AbstractReviewSubmission" SET "recommendedFormatKey" = "recommendedFormat"::text
  WHERE "recommendedFormat" IS NOT NULL AND "recommendedFormatKey" IS NULL;

-- The other direction: a built-in key with its enum empty (a database where
-- this image wrote before the triggers existed, such as one built by db push
-- and patched with this file afterwards). Never true on production.
UPDATE "Abstract" SET "presentationType" = "presentationTypeKey"::public."PresentationType"
  WHERE "presentationType" IS NULL AND "presentationTypeKey" = ANY (enum_range(NULL::public."PresentationType")::text[]);
UPDATE "Abstract" SET "requestedPresentationType" = "requestedPresentationTypeKey"::public."PresentationType"
  WHERE "requestedPresentationType" IS NULL AND "requestedPresentationTypeKey" = ANY (enum_range(NULL::public."PresentationType")::text[]);
UPDATE "AbstractReviewSubmission" SET "recommendedFormat" = "recommendedFormatKey"::public."RecommendedFormat"
  WHERE "recommendedFormat" IS NULL AND "recommendedFormatKey" = ANY (enum_range(NULL::public."RecommendedFormat")::text[]);
