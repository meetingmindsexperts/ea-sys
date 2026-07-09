-- Worker job-run records. Additive + blue-green safe (new enum + table).

DO $$ BEGIN
  CREATE TYPE "JobRunStatus" AS ENUM ('OK', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "JobRun" (
  "id"         TEXT NOT NULL,
  "job"        TEXT NOT NULL,
  "startedAt"  TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL,
  "status"     "JobRunStatus" NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "error"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobRun_job_startedAt_idx" ON "JobRun"("job", "startedAt");
CREATE INDEX IF NOT EXISTS "JobRun_startedAt_idx" ON "JobRun"("startedAt");
