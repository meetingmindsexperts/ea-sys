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
import { heldFixtures, planIssues, planSchema, readVenuePlan, type StoredVenuePlan, type VenuePlan } from "@/lib/venue/plan";
import { drawingFolder } from "@/lib/venue/underlay";
import { layoutFromPlan } from "@/lib/venue/plan-layout";

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
        return { ...cur, venue: { ...venue, rooms: { list: saved.rooms, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy }, ...prunedPlan(cur, saved.rooms) } };
      }, { organizationId: c.organizationId }),
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
      }, { organizationId: c.organizationId }),
    );
  } catch (err) {
    if (!(err instanceof NoRooms)) throw err;
    apiLogger.warn({ msg: "venue-rooms:refused", code: "NO_ROOMS", ...ctx });
    return { ok: false, code: "NO_ROOMS", message: "Save the rooms before opening the venue" };
  }
  apiLogger.info({ msg: "venue-rooms:open-changed", ...ctx });
  return { ok: true, open };
}


/**
 * A drawn plan follows the room list: a removed room's placement goes with
 * it, and so do the fixtures that stood in it. A room added since the plan
 * was drawn has no placement yet, so the venue stays automatic until the plan
 * places it (the Venue tab says so).
 */
function prunedPlan(cur: Record<string, unknown>, rooms: { id: string }[]): { plan?: unknown } {
  const stored = readVenuePlan(cur);
  if (!stored) return {};
  const keep = new Set(rooms.map((r) => r.id));
  const placed = stored.plan.rooms.filter((p) => keep.has(p.id));
  if (placed.length === stored.plan.rooms.length) return {};
  const fixtures = heldFixtures({ ...stored.plan, rooms: placed });
  return { plan: { plan: { ...stored.plan, rooms: placed, fixtures }, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy } };
}

export type SavePlanResult =
  | { ok: true; saved: StoredVenuePlan | null }
  | { ok: false; code: "INVALID_PLAN"; message: string; issues: string[] }
  | { ok: false; code: "NO_ROOMS"; message: string }
  | { ok: false; code: "STALE_VERSION"; message: string };

/**
 * Save a drawn plan, or (`raw` null) go back to the automatic plan.
 * `version` is the plan's `updatedAt` the editor loaded (0 when none). A plan
 * is refused unless every room on the list is placed, nothing overlaps, every
 * door opens onto a walkway or a room, the entrance is on an outside wall,
 * and the building it makes is walkable.
 */
export async function saveVenuePlan(c: Caller, raw: unknown, version: number): Promise<SavePlanResult> {
  const ctx = { organizationId: c.organizationId, eventId: c.eventId, userId: c.userId };
  let plan: VenuePlan | null = null;
  if (raw !== null) {
    const parsed = planSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = [...new Set(parsed.error.issues.map((i) => i.message))];
      apiLogger.warn({ msg: "venue-plan:refused", code: "INVALID_PLAN", ...ctx, issues });
      return { ok: false, code: "INVALID_PLAN", message: issues[0] ?? "The plan could not be saved", issues };
    }
    plan = parsed.data;
    // A drawing is this event's own upload: a path into another event's folder would show that event's
    // drawing through this one's (the drawing route serves only this event's folder, so it would also break).
    const foreign = (plan.underlays ?? []).filter((u) => !u.path.startsWith(drawingFolder(c.eventId)));
    if (foreign.length) {
      apiLogger.warn({ msg: "venue-plan:refused", code: "INVALID_PLAN", ...ctx, reason: "foreign-drawing", paths: foreign.map((u) => u.path) });
      const issue = "The venue drawing belongs to another event. Add it again on this one.";
      return { ok: false, code: "INVALID_PLAN", message: issue, issues: [issue] };
    }
  }
  class NoRooms extends Error {}
  class Invalid extends Error {
    constructor(readonly issues: string[]) {
      super("invalid plan");
    }
  }
  const saved: StoredVenuePlan | null = plan ? { plan, updatedAt: Date.now(), updatedBy: c.userId } : null;
  try {
    await runWithTenant(c.organizationId, () =>
      updateEventSettings(c.eventId, (cur) => {
        // Checked inside the locked update, against the room list as saved at this moment.
        const rooms = readVenueRooms(cur);
        if (!rooms) throw new NoRooms();
        if ((readVenuePlan(cur)?.updatedAt ?? 0) !== version) throw new StaleVersion();
        if (plan) {
          const shape = planIssues(rooms.rooms, plan);
          if (shape.length) throw new Invalid(shape);
          const built = layoutFromPlan(rooms.rooms, plan, { eventName: "" });
          if (built.issues.length) throw new Invalid(built.issues);
          const check = checkLayout(built.layout);
          if (!check.ok) throw new Invalid(check.issues);
        }
        const venue = cur.venue && typeof cur.venue === "object" ? { ...(cur.venue as Record<string, unknown>) } : {};
        if (saved) venue.plan = { plan: saved.plan, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy };
        else delete venue.plan;
        return { ...cur, venue };
      }, { organizationId: c.organizationId }),
    );
  } catch (err) {
    if (err instanceof NoRooms) {
      apiLogger.warn({ msg: "venue-plan:refused", code: "NO_ROOMS", ...ctx });
      return { ok: false, code: "NO_ROOMS", message: "Save the room list before drawing the plan" };
    }
    if (err instanceof StaleVersion) {
      apiLogger.warn({ msg: "venue-plan:refused", code: "STALE_VERSION", ...ctx, version });
      return { ok: false, code: "STALE_VERSION", message: "Someone else saved the plan since you opened it. Reload to see their changes." };
    }
    if (err instanceof Invalid) {
      apiLogger.warn({ msg: "venue-plan:refused", code: "INVALID_PLAN", ...ctx, issues: err.issues });
      return { ok: false, code: "INVALID_PLAN", message: err.issues[0], issues: err.issues };
    }
    throw err;
  }
  apiLogger.info({ msg: saved ? "venue-plan:saved" : "venue-plan:reset-to-automatic", ...ctx, rooms: saved?.plan.rooms.length ?? 0 });
  return { ok: true, saved };
}
