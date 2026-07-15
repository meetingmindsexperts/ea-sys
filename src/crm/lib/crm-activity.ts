/**
 * The CRM change-log writer — SERVER ONLY.
 *
 * This is the single source of the "detailed activity log" the detail sheets show.
 * Every CRM service calls `recordCrmActivity()` and NOTHING else writes to
 * `CrmActivity`, so the trail can never drift between callers (the AGENTS.md
 * no-cross-caller-duplication rule — the reason each service used to hand-roll its
 * own `writeAudit` was the smell this replaces).
 *
 * It imports `db` + the logger, so it MUST NOT be pulled into a "use client"
 * component. The client renders the log from the read route; the display labels it
 * needs are in the client-safe `crm-types.ts`.
 *
 * Fire-and-forget WITH a logged catch: an activity-insert blip must never 500 a
 * write that already committed (the registrations-review M13 class). The services
 * `void`-call it after the real mutation has landed.
 */
import { Prisma, type CrmActivityEntity } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export type { CrmActivityEntity };

export interface CrmActivityEntry {
  organizationId: string;
  entityType: CrmActivityEntity;
  entityId: string;
  /** CREATE | UPDATE | ARCHIVE | RESTORE | STAGE_MOVE | WON | LOST | … */
  action: string;
  actorId: string | null;
  changes?: Record<string, unknown>;
}

/**
 * Append one row to the change log. Never throws — a failure is logged (loudly,
 * per the "every failure path logs" rule) and swallowed, because the caller has
 * already committed the mutation this is merely recording.
 */
export function recordCrmActivity(entry: CrmActivityEntry): Promise<unknown> {
  return db.crmActivity
    .create({
      data: {
        organizationId: entry.organizationId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        actorId: entry.actorId,
        changes: (entry.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-activity:record-failed",
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

// ── Field diffing ─────────────────────────────────────────────────────────────

/** One field's change, as stored in `changes.changes[field]`. */
export interface FieldChange {
  from: string | number | boolean | null;
  to: string | number | boolean | null;
}

/**
 * Normalise a field value to something JSON-comparable and renderable.
 *
 * Prisma hands back `Decimal` (deal value), `Date` (dates) and `null`; the timeline
 * needs primitives. Decimals become numbers so a money diff renders as money;
 * Dates become ISO strings; everything else passes through.
 */
function normalize(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Prisma.Decimal) return v.toNumber();
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  // Unknown shape (shouldn't happen for the fields we diff) — stringify so the log
  // still says *something* rather than dropping the change silently.
  return String(v);
}

/**
 * Compute `{ field: { from, to } }` over the given keys, INCLUDING only the fields
 * that actually changed. Returns null when nothing changed (so the caller can skip
 * recording a no-op edit).
 *
 * `before`/`after` are the entity rows; `keys` is the whitelist of fields worth
 * logging (never dump the whole row — ids and timestamps are noise).
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: readonly (keyof T)[],
): Record<string, FieldChange> | null {
  const changes: Record<string, FieldChange> = {};
  for (const key of keys) {
    const from = normalize(before[key]);
    const to = normalize(after[key]);
    if (from !== to) {
      changes[String(key)] = { from, to };
    }
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export interface CrmActivityRecord {
  id: string;
  entityType: CrmActivityEntity;
  entityId: string;
  action: string;
  changes: Prisma.JsonValue;
  createdAt: Date;
  actor: { id: string; firstName: string; lastName: string } | null;
}

/**
 * Read the change log for one entity, newest first. Org-scoped by the caller (the
 * activity row carries the org it was written under), so no cross-tenant leak.
 */
export async function listCrmActivity(args: {
  organizationId: string;
  entityType: CrmActivityEntity;
  entityId: string;
  limit?: number;
}): Promise<CrmActivityRecord[]> {
  return db.crmActivity.findMany({
    where: {
      organizationId: args.organizationId,
      entityType: args.entityType,
      entityId: args.entityId,
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(args.limit ?? 200, 500),
    select: {
      id: true,
      entityType: true,
      entityId: true,
      action: true,
      changes: true,
      createdAt: true,
      actor: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}
