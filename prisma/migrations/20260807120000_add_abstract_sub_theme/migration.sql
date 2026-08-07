-- Sub-themes under an abstract theme (owner, Aug 7 2026).
--
-- Additive and idempotent: a new table plus one nullable column. Nothing
-- existing changes shape, so the old container keeps working through a
-- blue-green window (it simply never reads the column).
--
-- Optional by design — an event may have themes with no sub-themes, and those
-- submit exactly as before. Where a theme HAS sub-themes, the application
-- requires one to submit; that rule is not expressed here because it is
-- conditional on sibling rows, not on the column.

CREATE TABLE IF NOT EXISTS "AbstractSubTheme" (
  "id"             TEXT NOT NULL,
  "themeId"        TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "organizationId" TEXT,
  "name"           TEXT NOT NULL,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AbstractSubTheme_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AbstractSubTheme_themeId_name_key"
  ON "AbstractSubTheme"("themeId", "name");
CREATE INDEX IF NOT EXISTS "AbstractSubTheme_themeId_idx"          ON "AbstractSubTheme"("themeId");
CREATE INDEX IF NOT EXISTS "AbstractSubTheme_eventId_idx"          ON "AbstractSubTheme"("eventId");
CREATE INDEX IF NOT EXISTS "AbstractSubTheme_organizationId_idx"   ON "AbstractSubTheme"("organizationId");

-- Deleting a theme takes its sub-themes with it; deleting an event takes both.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AbstractSubTheme_themeId_fkey'
  ) THEN
    ALTER TABLE "AbstractSubTheme"
      ADD CONSTRAINT "AbstractSubTheme_themeId_fkey"
      FOREIGN KEY ("themeId") REFERENCES "AbstractTheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AbstractSubTheme_eventId_fkey'
  ) THEN
    ALTER TABLE "AbstractSubTheme"
      ADD CONSTRAINT "AbstractSubTheme_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "Abstract" ADD COLUMN IF NOT EXISTS "subThemeId" TEXT;

-- NO ACTION on the abstract side, matching how themeId already behaves: an
-- abstract must not vanish because a sub-theme was tidied up.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Abstract_subThemeId_fkey'
  ) THEN
    ALTER TABLE "Abstract"
      ADD CONSTRAINT "Abstract_subThemeId_fkey"
      FOREIGN KEY ("subThemeId") REFERENCES "AbstractSubTheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
