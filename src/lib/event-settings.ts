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
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

export type SettingsObject = Record<string, unknown>;
export type SettingsPatch = SettingsObject | ((current: SettingsObject) => SettingsObject);

async function mergeSettingsLocked(
  table: "Event" | "Organization",
  id: string,
  patch: SettingsPatch,
  notFoundError: string,
): Promise<SettingsObject> {
  return db.$transaction(async (tx) => {
    // Row-lock the row so concurrent settings writers serialize. Table name is
    // a hardcoded union (no injection surface); id is parameterized.
    const rows =
      table === "Event"
        ? await tx.$queryRaw<{ settings: SettingsObject | null }[]>`SELECT "settings" FROM "Event" WHERE "id" = ${id} FOR UPDATE`
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

/** Atomically merge a patch into `Event.settings`. Throws `EVENT_NOT_FOUND` if the event is gone. */
export function updateEventSettings(eventId: string, patch: SettingsPatch): Promise<SettingsObject> {
  return mergeSettingsLocked("Event", eventId, patch, "EVENT_NOT_FOUND");
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
  const events = await db.event.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      OR: [
        { settings: { path: ["reviewerUserIds"], array_contains: userId } },
        { settings: { path: ["onsiteUserIds"], array_contains: userId } },
      ],
    },
    select: { id: true },
  });

  for (const { id } of events) {
    await updateEventSettings(id, (cur) => {
      const strip = (key: string) => {
        const list = cur[key];
        return Array.isArray(list) ? list.filter((v) => v !== userId) : list;
      };
      return { ...cur, reviewerUserIds: strip("reviewerUserIds"), onsiteUserIds: strip("onsiteUserIds") };
    });
  }

  return { eventsTouched: events.length };
}
