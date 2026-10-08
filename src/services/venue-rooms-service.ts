/**
 * The event's online venue rooms (docs/EVENT_BLUEPRINT_PLAN.md, D9): saved in
 * `Event.settings.venue.rooms` through the locked settings merge, with a
 * version check so two organisers editing at once cannot overwrite each other.
 * The route decides who may call; this service trusts its caller. Errors are
 * values; never imports next/server.
 */
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { updateEventSettings } from "@/lib/event-settings";
import { readVenueRooms, roomsSchema, type StoredVenueRooms } from "@/lib/venue/rooms";
import { generateLayout } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";

export type SaveRoomsResult =
  | { ok: true; saved: StoredVenueRooms }
  | { ok: false; code: "INVALID_ROOMS"; message: string; issues: string[] }
  | { ok: false; code: "STALE_VERSION"; message: string };

class StaleVersion extends Error {}

interface Caller {
  organizationId: string;
  eventId: string;
  userId: string;
}

/**
 * Save the room list. `version` is the `updatedAt` the editor loaded (0 when
 * none was saved); a newer save in between refuses this one.
 */
export async function saveVenueRooms(c: Caller, raw: unknown, version: number): Promise<SaveRoomsResult> {
  const ctx = { organizationId: c.organizationId, eventId: c.eventId, userId: c.userId };
  const parsed = roomsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = [...new Set(parsed.error.issues.map((i) => i.message))];
    apiLogger.warn({ msg: "venue-rooms:refused", code: "INVALID_ROOMS", ...ctx, issues });
    return { ok: false, code: "INVALID_ROOMS", message: issues[0] ?? "The room list could not be saved", issues };
  }
  // The rooms pass the rules; the building made from them must also be walkable (D10). The rules are
  // written so it always is, so a refusal here means the generator and the rules disagree.
  const check = checkLayout(generateLayout(parsed.data, { eventName: "" }));
  if (!check.ok) {
    apiLogger.error({ msg: "venue-rooms:layout-not-walkable", ...ctx, issues: check.issues });
    return { ok: false, code: "INVALID_ROOMS", message: "These rooms cannot be laid out as a walkable venue yet", issues: check.issues };
  }
  const saved: StoredVenueRooms = { rooms: parsed.data, updatedAt: Date.now(), updatedBy: c.userId };
  try {
    await runWithTenant(c.organizationId, () =>
      updateEventSettings(c.eventId, (cur) => {
        const current = readVenueRooms(cur);
        if ((current?.updatedAt ?? 0) !== version) throw new StaleVersion();
        const venue = cur.venue && typeof cur.venue === "object" ? (cur.venue as Record<string, unknown>) : {};
        return { ...cur, venue: { ...venue, rooms: { list: saved.rooms, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy } } };
      }),
    );
  } catch (err) {
    if (!(err instanceof StaleVersion)) throw err;
    apiLogger.warn({ msg: "venue-rooms:refused", code: "STALE_VERSION", ...ctx, version });
    return { ok: false, code: "STALE_VERSION", message: "Someone else saved the rooms since you opened them. Reload to see their changes." };
  }
  apiLogger.info({ msg: "venue-rooms:saved", ...ctx, rooms: saved.rooms.length });
  return { ok: true, saved };
}

export type OpenVenueResult = { ok: true; open: boolean } | { ok: false; code: "NO_ROOMS"; message: string };

/** The event team opens the generated venue to staff, or closes it. Opening needs saved rooms. */
export async function setVenueOpen(c: Caller, open: boolean): Promise<OpenVenueResult> {
  const ctx = { organizationId: c.organizationId, eventId: c.eventId, userId: c.userId, open };
  class NoRooms extends Error {}
  try {
    await runWithTenant(c.organizationId, () =>
      updateEventSettings(c.eventId, (cur) => {
        if (open && !readVenueRooms(cur)) throw new NoRooms();
        const venue = cur.venue && typeof cur.venue === "object" ? (cur.venue as Record<string, unknown>) : {};
        return { ...cur, venue: { ...venue, open } };
      }),
    );
  } catch (err) {
    if (!(err instanceof NoRooms)) throw err;
    apiLogger.warn({ msg: "venue-rooms:refused", code: "NO_ROOMS", ...ctx });
    return { ok: false, code: "NO_ROOMS", message: "Save the rooms before opening the venue" };
  }
  apiLogger.info({ msg: "venue-rooms:open-changed", ...ctx });
  return { ok: true, open };
}

