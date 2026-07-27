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

/**
 * Bulk variant for imports: one createMany instead of N round-trips. Still THIS
 * module — nothing outside crm-activity.ts may write the table (the one-writer
 * invariant that keeps the trail from drifting between callers). Never throws.
 */
export function recordCrmActivityBulk(entries: CrmActivityEntry[]): Promise<unknown> {
  if (entries.length === 0) return Promise.resolve();
  return db.crmActivity
    .createMany({
      data: entries.map((e) => ({
        organizationId: e.organizationId,
        entityType: e.entityType,
        entityId: e.entityId,
        action: e.action,
        actorId: e.actorId,
        changes: (e.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    })
    .catch((err: unknown) => {
      apiLogger.error({
        msg: "crm-activity:record-bulk-failed",
        count: entries.length,
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

const ACTIVITY_SELECT = {
  id: true,
  entityType: true,
  entityId: true,
  action: true,
  changes: true,
  createdAt: true,
  actor: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.CrmActivitySelect;

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
    select: ACTIVITY_SELECT,
  });
}

// ── Org-wide activity feed (the "Activity" tab) ────────────────────────────────

export interface OrgActivityFilters {
  organizationId: string;
  /** Filter to one actor (user). */
  actorId?: string | null;
  entityType?: CrmActivityEntity | null;
  action?: string | null;
  /** Inclusive lower bound. */
  from?: Date | null;
  /** Inclusive upper bound (the route stamps it to end-of-day). */
  to?: Date | null;
}

export interface OrgActivityRecord extends CrmActivityRecord {
  /** Resolved entity name (deal/company/contact title), null once purged. */
  entityName: string | null;
}

/**
 * Build the WHERE for an org-wide activity query. Shared by the feed (cursor-paged)
 * and the CSV export so they can never disagree on what a filter means. Always
 * org-scoped; every other clause is optional.
 */
export function buildOrgActivityWhere(f: OrgActivityFilters): Prisma.CrmActivityWhereInput {
  const where: Prisma.CrmActivityWhereInput = { organizationId: f.organizationId };
  if (f.actorId) where.actorId = f.actorId;
  if (f.entityType) where.entityType = f.entityType;
  if (f.action) where.action = f.action;
  if (f.from || f.to) {
    where.createdAt = {};
    if (f.from) where.createdAt.gte = f.from;
    if (f.to) where.createdAt.lte = f.to;
  }
  return where;
}

/**
 * Batch-resolve the display name of each row's entity — one findMany per type,
 * org-scoped (defence in depth; a mis-scoped id can't surface another org's name).
 * A purged entity has no row, so its name resolves to null (rendered "(removed)").
 */
async function resolveEntityNames(
  organizationId: string,
  rows: readonly CrmActivityRecord[],
): Promise<Map<string, string>> {
  const ids: Record<CrmActivityEntity, Set<string>> = {
    DEAL: new Set(),
    COMPANY: new Set(),
    CONTACT: new Set(),
    TASK: new Set(),
  };
  for (const r of rows) ids[r.entityType].add(r.entityId);
  const key = (t: CrmActivityEntity, id: string) => `${t}:${id}`;
  const map = new Map<string, string>();

  const [deals, companies, contacts, tasks] = await Promise.all([
    ids.DEAL.size
      ? db.crmDeal.findMany({ where: { organizationId, id: { in: [...ids.DEAL] } }, select: { id: true, name: true } })
      : [],
    ids.COMPANY.size
      ? db.crmCompany.findMany({ where: { organizationId, id: { in: [...ids.COMPANY] } }, select: { id: true, name: true } })
      : [],
    ids.CONTACT.size
      ? db.crmContact.findMany({
          where: { organizationId, id: { in: [...ids.CONTACT] } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
    ids.TASK.size
      ? db.crmTask.findMany({ where: { organizationId, id: { in: [...ids.TASK] } }, select: { id: true, title: true } })
      : [],
  ]);
  for (const d of deals) map.set(key("DEAL", d.id), d.name);
  for (const c of companies) map.set(key("COMPANY", c.id), c.name);
  for (const c of contacts) map.set(key("CONTACT", c.id), `${c.firstName} ${c.lastName}`.trim());
  for (const t of tasks) map.set(key("TASK", t.id), t.title);
  return map;
}

function attachNames(organizationId: string, rows: CrmActivityRecord[]): Promise<OrgActivityRecord[]> {
  return resolveEntityNames(organizationId, rows).then((names) =>
    rows.map((r) => ({ ...r, entityName: names.get(`${r.entityType}:${r.entityId}`) ?? null })),
  );
}

/**
 * The org-wide feed, newest first, cursor-paged. Orders by (createdAt, id) both
 * descending so the id tiebreak keeps the cursor stable when two rows share a
 * timestamp. Returns up to `limit` rows plus the id to pass as the next cursor.
 */
export async function listOrgCrmActivity(
  f: OrgActivityFilters & { cursor?: string | null; limit?: number },
): Promise<{ rows: OrgActivityRecord[]; nextCursor: string | null }> {
  const take = Math.min(f.limit ?? 50, 200);
  const found = await db.crmActivity.findMany({
    where: buildOrgActivityWhere(f),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1, // one extra to know whether there's another page
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    select: ACTIVITY_SELECT,
  });
  const hasMore = found.length > take;
  const page = hasMore ? found.slice(0, take) : found;
  const rows = await attachNames(f.organizationId, page);
  return { rows, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

const ORG_ACTIVITY_ENTITY_TYPES = new Set<CrmActivityEntity>(["DEAL", "COMPANY", "CONTACT", "TASK"]);

/**
 * Parse the org-wide-activity query params into a filter object — shared by the
 * feed AND the export route so a filter means the same thing in both. `entityType`
 * is validated against the enum (a hand-crafted bad value is a 400, not a silent
 * widen); an unparseable date is treated as absent (a read-only view showing more
 * rows is harmless, unlike a bad send-audience filter).
 */
export function parseOrgActivityFilters(
  searchParams: URLSearchParams,
  organizationId: string,
): { ok: true; filters: OrgActivityFilters } | { ok: false } {
  const entityTypeRaw = searchParams.get("entityType")?.trim() || null;
  if (entityTypeRaw && !ORG_ACTIVITY_ENTITY_TYPES.has(entityTypeRaw as CrmActivityEntity)) {
    return { ok: false };
  }
  const parseDate = (s: string | null, endOfDay: boolean): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    if (endOfDay) d.setHours(23, 59, 59, 999);
    return d;
  };
  return {
    ok: true,
    filters: {
      organizationId,
      actorId: searchParams.get("actorId")?.trim() || null,
      entityType: (entityTypeRaw as CrmActivityEntity | null) ?? null,
      action: searchParams.get("action")?.trim() || null,
      from: parseDate(searchParams.get("from"), false),
      to: parseDate(searchParams.get("to"), true),
    },
  };
}

/** The same query, un-paged (capped), for the CSV export. */
export async function listOrgCrmActivityForExport(
  f: OrgActivityFilters,
  cap = 5000,
): Promise<OrgActivityRecord[]> {
  const found = await db.crmActivity.findMany({
    where: buildOrgActivityWhere(f),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: cap,
    select: ACTIVITY_SELECT,
  });
  return attachNames(f.organizationId, found);
}
