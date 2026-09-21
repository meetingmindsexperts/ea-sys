-- Event Agent stored runs: the person's message, the agent's reply and each
-- tool call's input (owner decision, Sep 21, 2026: "I need messages list"),
-- read by the SUPER_ADMIN /admin/agent-messages page. This reverses the
-- "never the text" rule of 20260921120000_add_agent_runs; the reasoning and
-- the bounds live in src/lib/agent/run-store.ts.
--
-- SAFETY
--   * Purely ADDITIVE: three nullable columns, no default, no index change.
--   * Idempotent: ADD COLUMN IF NOT EXISTS. A re-run is a no-op.
--   * Blue/green safe: migrations run BEFORE the container swap; the old
--     container inserts without these columns (NULL) and selects by name.
--   * No backfill: the text was never kept, so there is nothing to fill.
--   * Retention: the rows already leave through the 180-day agent-run prune
--     (steps by FK cascade), so the text needs no sweep of its own.

ALTER TABLE "AgentRun"  ADD COLUMN IF NOT EXISTS "message" TEXT;
ALTER TABLE "AgentRun"  ADD COLUMN IF NOT EXISTS "reply"   TEXT;
ALTER TABLE "AgentStep" ADD COLUMN IF NOT EXISTS "input"   JSONB;
