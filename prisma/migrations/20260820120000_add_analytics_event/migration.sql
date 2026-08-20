-- Analytics: one row per measured hit on a public page.
-- See docs/ANALYTICS_PLAN.md.
--
-- SAFETY
--   * Purely ADDITIVE. One new table and its indexes. No existing table is
--     touched, no column altered, no data migrated. Nothing can be lost by
--     applying it and nothing existing changes behaviour.
--   * Idempotent: IF NOT EXISTS throughout, so a re-run is a no-op.
--   * Blue/green safe: migrations run BEFORE the container swap, and the
--     still-live old container simply never references this table.
--
-- NOTE ON WHAT IS NOT HERE
--   There is deliberately no ipAddress column, no userId, and no foreign key.
--   The first two are the privacy contract (the IP is consumed to derive
--   visitorHash and then discarded); the third is because a hit that outlives
--   its event is still a valid historical fact, and a cascade would silently
--   delete traffic history when an event is removed.

CREATE TABLE IF NOT EXISTS "AnalyticsEvent" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT,
  "eventId"        TEXT,
  "siteId"         TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "path"           TEXT NOT NULL,
  "routePattern"   TEXT NOT NULL,
  "visitorHash"    TEXT NOT NULL,
  "sessionHash"    TEXT NOT NULL,
  "referrerHost"   TEXT,
  "utmSource"      TEXT,
  "utmMedium"      TEXT,
  "utmCampaign"    TEXT,
  "deviceType"     TEXT,
  "browser"        TEXT,
  "os"             TEXT,
  "country"        TEXT,
  "durationMs"     INTEGER,
  "scrollDepth"    INTEGER,
  "value"          DECIMAL(10,2),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- The main chart: one site over a window.
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_siteId_createdAt_idx"
  ON "AnalyticsEvent" ("siteId", "createdAt");

-- Funnel steps for one event.
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_eventId_name_createdAt_idx"
  ON "AnalyticsEvent" ("eventId", "name", "createdAt");

-- Tenancy scoping.
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_organizationId_idx"
  ON "AnalyticsEvent" ("organizationId");

-- Unique-visitor and session rollups.
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_visitorHash_createdAt_idx"
  ON "AnalyticsEvent" ("visitorHash", "createdAt");

-- Retention sweep, which prunes by age across every org.
CREATE INDEX IF NOT EXISTS "AnalyticsEvent_createdAt_idx"
  ON "AnalyticsEvent" ("createdAt");
