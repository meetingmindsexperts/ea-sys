-- Public doc links (Sep 25, 2026): a repo HTML doc the platform operator made
-- public. Additive and idempotent: a new table only, nothing else touched.
CREATE TABLE IF NOT EXISTS "PublicDoc" (
    "path" TEXT NOT NULL,
    "sharedByUserId" TEXT NOT NULL,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublicDoc_pkey" PRIMARY KEY ("path")
);
