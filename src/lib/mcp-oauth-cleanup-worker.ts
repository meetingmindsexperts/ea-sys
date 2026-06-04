/**
 * MCP OAuth cleanup worker — hourly garbage-collect of OAuth state.
 *
 * Deletes:
 *  - Expired authorization codes (TTL = 10 min, leaked on abandoned flows)
 *  - Access tokens whose `expiresAt` is more than 7 days in the past
 *    (the grace window where a client could still refresh)
 *
 * Extracted from `/api/cron/mcp-oauth-cleanup/route.ts` as part of the
 * Phase 1 worker-extraction refactor (see
 * docs/WORKER_EXTRACTION_PLAN.md). The route handler is now a thin
 * shim that auth-checks the Bearer CRON_SECRET and delegates to
 * `runMcpOAuthCleanupTick()`; the same function will be invoked by the
 * node-cron worker process during Phase 2-3. Behavior is unchanged
 * from the previous all-in-the-route shape.
 *
 * Why a worker for two `deleteMany` calls: consistency with the rest
 * of the cron surfaces. The node-cron scheduler in Phase 2 will
 * register all 5 jobs the same way; having a per-tick function for
 * each keeps the bootstrap loop uniform. The runtime cost is trivial
 * (two DB queries every hour).
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

// Grace period after an access token's `expiresAt` during which the
// refresh-token flow could still resurrect a session. Beyond this we
// assume the client has either re-authorized or moved on.
export const TOKEN_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export interface McpOAuthCleanupTickReport {
  expiredCodes: number;
  expiredTokens: number;
  durationMs: number;
}

/**
 * One MCP OAuth cleanup tick. Pure async function — no HTTP, no auth,
 * no NextResponse. Callable from either the legacy route shim or the
 * future node-cron worker process.
 */
export async function runMcpOAuthCleanupTick(): Promise<McpOAuthCleanupTickReport> {
  const startedAt = Date.now();
  const now = new Date();
  const tokenCutoff = new Date(now.getTime() - TOKEN_GRACE_PERIOD_MS);

  const [codes, tokens] = await Promise.all([
    db.mcpOAuthAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.mcpOAuthAccessToken.deleteMany({ where: { expiresAt: { lt: tokenCutoff } } }),
  ]);

  const durationMs = Date.now() - startedAt;
  apiLogger.info({
    msg: "mcp-oauth-cleanup:tick-complete",
    expiredCodes: codes.count,
    expiredTokens: tokens.count,
    durationMs,
  });

  return {
    expiredCodes: codes.count,
    expiredTokens: tokens.count,
    durationMs,
  };
}
