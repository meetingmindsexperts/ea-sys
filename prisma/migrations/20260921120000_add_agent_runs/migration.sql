-- Event Agent stored runs (docs/AGENT_ARCHITECTURE_REVIEW.md §4.6, the
-- readiness review's O1): one row per in-app agent request and one per tool
-- call inside it. Names, counts, tokens and outcomes only. The message text,
-- the tool inputs and the tool results are never stored.
--
-- SAFETY
--   * Purely ADDITIVE: two enums, two new tables, their indexes and one FK
--     between the two new tables. No existing table is touched.
--   * Idempotent throughout: DO blocks for the enums and the FK (CREATE TYPE
--     and ADD CONSTRAINT have no IF NOT EXISTS), IF NOT EXISTS on the tables
--     and indexes. A re-run is a no-op.
--   * Blue/green safe: migrations run BEFORE the container swap and the
--     still-live old container never references any of this.
--   * No backfill: recording starts with the first request after deploy.
--
-- People are scalar ids (userId, eventId), never foreign keys, so a run
-- outlives the account and the event it named (the LoginEvent convention).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentRunOutcome') THEN
    CREATE TYPE "AgentRunOutcome" AS ENUM ('RUNNING', 'COMPLETED', 'ERROR', 'TURN_LIMIT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentStepOutcome') THEN
    CREATE TYPE "AgentStepOutcome" AS ENUM ('RAN', 'ERROR', 'REFUSED', 'APPROVAL_REQUESTED', 'UNKNOWN_TOOL');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "AgentRun" (
  "id"                  TEXT NOT NULL,
  "organizationId"      TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "role"                TEXT NOT NULL,
  "eventId"             TEXT,
  "route"               TEXT NOT NULL,
  "source"              TEXT NOT NULL DEFAULT 'agent',
  "messageLength"       INTEGER NOT NULL,
  "historyPairs"        INTEGER NOT NULL DEFAULT 0,
  "approvedTool"        TEXT,
  "model"               TEXT,
  "outcome"             "AgentRunOutcome" NOT NULL DEFAULT 'RUNNING',
  "errorClass"          TEXT,
  "turns"               INTEGER NOT NULL DEFAULT 0,
  "toolCalls"           INTEGER NOT NULL DEFAULT 0,
  "writes"              INTEGER NOT NULL DEFAULT 0,
  "refusals"            INTEGER NOT NULL DEFAULT 0,
  "approvalsRequested"  INTEGER NOT NULL DEFAULT 0,
  "approvalsRun"        INTEGER NOT NULL DEFAULT 0,
  "toolErrors"          INTEGER NOT NULL DEFAULT 0,
  "inputTokens"         INTEGER NOT NULL DEFAULT 0,
  "outputTokens"        INTEGER NOT NULL DEFAULT 0,
  "cacheReadTokens"     INTEGER NOT NULL DEFAULT 0,
  "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
  "startedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"          TIMESTAMP(3),
  "durationMs"          INTEGER,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentRun_organizationId_startedAt_idx" ON "AgentRun"("organizationId", "startedAt");
CREATE INDEX IF NOT EXISTS "AgentRun_userId_startedAt_idx"         ON "AgentRun"("userId", "startedAt");
CREATE INDEX IF NOT EXISTS "AgentRun_eventId_startedAt_idx"        ON "AgentRun"("eventId", "startedAt");
CREATE INDEX IF NOT EXISTS "AgentRun_startedAt_idx"                ON "AgentRun"("startedAt");

CREATE TABLE IF NOT EXISTS "AgentStep" (
  "id"             TEXT NOT NULL,
  "runId"          TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "seq"            INTEGER NOT NULL,
  "tool"           TEXT NOT NULL,
  "outcome"        "AgentStepOutcome" NOT NULL,
  "code"           TEXT,
  "write"          BOOLEAN NOT NULL DEFAULT false,
  "approved"       BOOLEAN NOT NULL DEFAULT false,
  "durationMs"     INTEGER NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentStep_runId_seq_idx"                 ON "AgentStep"("runId", "seq");
CREATE INDEX IF NOT EXISTS "AgentStep_organizationId_createdAt_idx"  ON "AgentStep"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentStep_tool_createdAt_idx"            ON "AgentStep"("tool", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentStep_runId_fkey'
  ) THEN
    ALTER TABLE "AgentStep"
      ADD CONSTRAINT "AgentStep_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
