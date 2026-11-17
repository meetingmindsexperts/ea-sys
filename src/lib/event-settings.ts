/**
 * Atomic, race-safe updates to the `Event.settings` / `Organization.settings`
 * JSON blobs.
 *
 * The blob holds many independent features' config (reviewerUserIds, sponsors,
 * webinar, zoom, cme, registrationOpen, …). The naive update — read the whole
 * blob, spread a key, write the whole blob back — is a **lost-update race**:
 * two requests that touch DIFFERENT keys both read the old blob and the second
 * write silently drops the first's change.
 *
 * These helpers serialize the read-modify-write with a `SELECT … FOR UPDATE`
 * row lock inside a transaction, so concurrent settings writers to the same
 * row queue up and each reads the previous writer's committed value. (Prisma's
 * `$transaction` runs all its queries on one backend connection — including
 * through the pgbouncer transaction pooler — so the row lock holds for the tx.)
 *
 * Two patch modes:
 *  - **object** → shallow-merge: `{ ...current, ...patch }` (top-level keys in
 *    `patch` replace; unspecified keys are preserved). Use for "set my key".
 *  - **function** → `(current) => next`: returns the COMPLETE next settings,
 *    computed from the freshly-locked current. Use for array append/remove or
 *    key deletion (the caller spreads `current` itself).
 */
import { db, tenantTransaction } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { runWithTenant } from "@/lib/tenant-context";

export type SettingsObject = Record<string, unknown>;
export type SettingsPatch = SettingsObject | ((current: SettingsObject) => SettingsObject);

/** Lock the event's row, only within `organizationId` when given. */
function lockEvent(tx: Prisma.TransactionClient, id: string, organizationId?: string) {
  if (!organizationId) return tx.$queryRaw<{ settings: SettingsObject | null }[]>`SELECT "settings" FROM "Event" WHERE "id" = ${id} FOR UPDATE`;
  return tx.$queryRaw<{ settings: SettingsObject | null }[]>`SELECT "settings" FROM "Event" WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
}

async function mergeSettingsLocked(
  table: "Event" | "Organization",
  id: string,
  patch: SettingsPatch,
  notFoundError: string,
  organizationId?: string,
): Promise<SettingsObject> {
  // `tenantTransaction`, not `db.$transaction` (review of 2db57e7f). On master
  // the two are the same transaction. Where row security is on, the raw lock
  // below is not a model operation, so nothing would tell its backend whose
  // rows it may see: under an Event policy it finds no row, and with the
  // policy absent the update after it is moved to a second backend that waits
  // on the lock this one holds until the transaction times out.
  // `tenantTransaction` sets the organisation on the transaction's own backend
  // first. With no lane it is plain `db.$transaction`, as before.
  return tenantTransaction(async (tx) => {
    // Row-lock the row so concurrent settings writers serialize. Table name is
    // a hardcoded union (no injection surface); id is parameterized.
    const rows =
      table === "Event"
        ? await lockEvent(tx, id, organizationId)
        : await tx.$queryRaw<{ settings: SettingsObject | null }[]>`SELECT "settings" FROM "Organization" WHERE "id" = ${id} FOR UPDATE`;
    if (rows.length === 0) throw new Error(notFoundError);

    const current = (rows[0].settings ?? {}) as SettingsObject;
    const merged = typeof patch === "function" ? patch(current) : { ...current, ...patch };

    if (table === "Event") {
      await tx.event.update({ where: { id }, data: { settings: merged as Prisma.InputJsonValue } });
    } else {
      await tx.organization.update({ where: { id }, data: { settings: merged as Prisma.InputJsonValue } });
    }
    return merged;
  });
}

/**
 * Atomically merge a patch into `Event.settings`. Throws `EVENT_NOT_FOUND` if the event is gone, or, with
 * `organizationId`, if it belongs to another organisation: a second wall behind the route's own check
 * (Event has no row-level policy, so nothing else would stop a mis-scoped id; venue tenancy review, Oct 27).
 */
export function updateEventSettings(eventId: string, patch: SettingsPatch, opts: { organizationId?: string } = {}): Promise<SettingsObject> {
  const merge = () => mergeSettingsLocked("Event", eventId, patch, "EVENT_NOT_FOUND", opts.organizationId);
  // A caller that names the organisation gets its lane here as well (Event RLS
  // step 2, Nov 17 2026): the merge is a tenant transaction, and a tenant
  // transaction with no lane around it is a plain one, which finds no row once
  // Event has a policy. A caller that names none must already be inside a lane.
  return opts.organizationId ? runWithTenant(opts.organizationId, merge) : merge();
}

/** Atomically merge a patch into `Organization.settings`. Throws `ORGANIZATION_NOT_FOUND` if gone. */
export function updateOrganizationSettings(organizationId: string, patch: SettingsPatch): Promise<SettingsObject> {
  return mergeSettingsLocked("Organization", organizationId, patch, "ORGANIZATION_NOT_FOUND");
}

/**
 * Remove a user id from every event's `reviewerUserIds` / `onsiteUserIds`.
 *
 * Those lists live in settings JSON rather than as foreign keys, so nothing
 * cascades when the user row is deleted: their id stayed in the array forever
 * and the Reviewers / Onsite Staff pages rendered a phantom entry (found while
 * adding session revocation, Aug 11 2026).
 *
 * Not a security fix. A stale id cannot grant anything now that the session is
 * invalidated on delete, and cuids are never reissued. This is litter removal,
 * so callers treat a failure as loggable rather than fatal.
 *
 * Goes through `updateEventSettings`, which takes the row lock, so a concurrent
 * "add a reviewer" cannot be clobbered by this read-modify-write.
 */
export async function removeUserFromEventSettings(
  userId: string,
  organizationId: string | null,
): Promise<{ eventsTouched: number }> {
  // Inside the organisation's lane when the caller names one (Event RLS step
  // 2, Nov 17 2026). With none, the sweep is meant to span organisations and
  // has no lane to enter: with row security on it finds nothing, and the stale
  // ids stay (they grant nothing; see above).
  const inLane = <T>(fn: () => Promise<T>) => (organizationId ? runWithTenant(organizationId, fn) : fn());
  const events = await inLane(() =>
    db.event.findMany({
      where: {
        ...(organizationId ? { organizationId } : {}),
        OR: [
          { settings: { path: ["reviewerUserIds"], array_contains: userId } },
          { settings: { path: ["onsiteUserIds"], array_contains: userId } },
        ],
      },
      select: { id: true },
    }),
  );

  for (const { id } of events) {
    await updateEventSettings(
      id,
      (cur) => {
        const strip = (key: string) => {
          const list = cur[key];
          return Array.isArray(list) ? list.filter((v) => v !== userId) : list;
        };
        return { ...cur, reviewerUserIds: strip("reviewerUserIds"), onsiteUserIds: strip("onsiteUserIds") };
      },
      organizationId ? { organizationId } : {},
    );
  }

  return { eventsTouched: events.length };
}
