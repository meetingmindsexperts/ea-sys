import { z } from "zod";

/**
 * Optimistic-locking primitives for "last write doesn't silently win".
 *
 * Pattern (ETag-style, using the row's existing `updatedAt` as the version
 * token — no schema change required, since every model already has
 * `@updatedAt`):
 *
 *   1. Client GET reads the resource and remembers `updatedAt`.
 *   2. Client PUT/PATCH sends `expectedUpdatedAt` alongside the change set.
 *   3. Server runs a conditional UPDATE — `WHERE id = ? AND updatedAt = ?`.
 *      If zero rows changed, somebody else wrote first (or the row no longer
 *      exists). Return 409 STALE_WRITE rather than silently overwriting.
 *
 * Why `updatedAt` instead of a dedicated `version Int` column?
 *   - No migration. `@updatedAt` is on every Prisma model already.
 *   - Round-trips cleanly as ISO-8601 in JSON (millisecond precision).
 *   - The token is the same value the client reads via GET.
 *
 * Caveat: `TIMESTAMPTZ(3)` is millisecond-precision. Two writes inside the
 * same millisecond would both pass the check. Realistically rare for
 * human-driven UI flows but **not safe for high-frequency machine writers**.
 * For those callers add a dedicated `version Int` column or use a
 * transactional row lock.
 *
 * Backwards-compat: when `expectedUpdatedAt` is absent the helpers fall
 * back to the legacy "blind write" behavior with a `apiLogger.warn` so we
 * can see which callers haven't migrated. The plan is to require it across
 * the board once dashboards / MCP / scripts are all sending it.
 */

import { apiLogger } from "@/lib/logger";

/**
 * Zod schema fragment to spread into a route's body schema:
 *
 *   const updateSchema = z.object({
 *     ...optimisticLockField,
 *     name: z.string().optional(),
 *     ...
 *   });
 */
export const optimisticLockField = {
  /**
   * The `updatedAt` value the client read when it fetched this resource.
   * If supplied, the server runs a conditional UPDATE and returns 409 on
   * stale writes. Optional during rollout.
   */
  expectedUpdatedAt: z
    .string()
    .datetime()
    .optional()
    .nullable(),
} as const;

/** Outcome of `runOptimisticUpdate`. Lets callers branch on each case. */
export type OptimisticUpdateResult =
  | { ok: true }
  | { ok: false; reason: "STALE_WRITE" }
  | { ok: false; reason: "NOT_FOUND" };

/**
 * Wrapper around a model's `updateMany` that enforces an optimistic lock
 * on `updatedAt` when the client supplied an expected value.
 *
 * Usage:
 *   const result = await runOptimisticUpdate({
 *     model: db.speaker,
 *     where: { id: speakerId, eventId },
 *     data: { ...changes, updatedAt: new Date() },
 *     expectedUpdatedAt,
 *     resourceLabel: "speaker",
 *     resourceId: speakerId,
 *   });
 *   if (!result.ok && result.reason === "STALE_WRITE") return 409;
 *   if (!result.ok && result.reason === "NOT_FOUND") return 404;
 *   // load the freshly-updated row for the response (caller picks include shape)
 */
export async function runOptimisticUpdate<TWhere, TData>(opts: {
  model: {
    updateMany: (args: { where: TWhere; data: TData }) => Promise<{ count: number }>;
    findFirst: (args: { where: TWhere; select: { id: true } }) => Promise<{ id: string } | null>;
  };
  /** WHERE clause that already scopes the row (id + eventId etc). */
  where: TWhere;
  /** Data to write. Caller should include an explicit `updatedAt: new Date()`. */
  data: TData;
  /** Token from the client (ISO string) — null/undefined means "skip the lock". */
  expectedUpdatedAt: string | null | undefined;
  /** Used in the warn log when a caller skips the lock — helps us track migration. */
  resourceLabel: string;
  resourceId: string;
}): Promise<OptimisticUpdateResult> {
  const { model, where, data, expectedUpdatedAt, resourceLabel, resourceId } = opts;

  if (expectedUpdatedAt) {
    const lockedWhere = {
      ...(where as Record<string, unknown>),
      updatedAt: new Date(expectedUpdatedAt),
    } as TWhere;

    const result = await model.updateMany({ where: lockedWhere, data });
    if (result.count === 0) {
      // Distinguish 404 (row gone) vs 409 (someone else wrote first).
      // The unscoped findFirst uses the original where (without updatedAt).
      const stillExists = await model.findFirst({
        where,
        select: { id: true },
      });
      if (!stillExists) return { ok: false, reason: "NOT_FOUND" };
      return { ok: false, reason: "STALE_WRITE" };
    }
    return { ok: true };
  }

  // Legacy unconditional path. Same query shape but no lock — emit a warn so
  // we can audit which callers haven't migrated yet.
  apiLogger.warn({
    msg: "optimistic-lock:missing-expectedUpdatedAt",
    resource: resourceLabel,
    resourceId,
  });
  const result = await model.updateMany({ where, data });
  if (result.count === 0) return { ok: false, reason: "NOT_FOUND" };
  return { ok: true };
}
