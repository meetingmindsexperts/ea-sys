-- Cross-process admin-alert state (dedup + global ceiling + silence window).
--
-- Additive and idempotent → blue-green safe. The old code carries an in-memory
-- dedup Map and never looks at this table; the new code claims a send here.
-- Nothing breaks in the window where both slots are alive.
CREATE TABLE IF NOT EXISTS "AlertState" (
    "key"             TEXT         NOT NULL,
    "lastSentAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "counter"         INTEGER      NOT NULL DEFAULT 0,
    "silencedUntil"   TIMESTAMP(3),
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertState_pkey" PRIMARY KEY ("key")
);
