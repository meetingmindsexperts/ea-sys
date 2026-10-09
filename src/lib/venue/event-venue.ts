/**
 * Which venue an event serves, and its layout (docs/EVENT_BLUEPRINT_PLAN.md,
 * D9 and D10). An event's venue is served when either:
 *   - its id or slug is listed in VENUE_EVENT_SLUGS (EHC's hand-built rooms, phase 4),
 *   - or VENUE_MODULE_ENABLED is on, its rooms are saved on the Venue tab and
 *     the event team opened it.
 * Saved rooms always win: the venue is generated from them, and checked
 * walkable again before it is served (the rules or the generator may have
 * changed since the save).
 */
import { apiLogger } from "@/lib/logger";
import { isVenueEnabledFor, isVenueModuleEnabled } from "@/lib/module-flags";
import { generateLayout, type VenueLayout } from "./layout";
import { checkLayout } from "./layout-check";
import { readVenueOpen, readVenueRooms } from "./rooms";
import type { VenueRoomRef } from "./programme";
import vocab from "./persona-vocab.generated.json";

export function isVenueServed(event: { id: string; slug: string; settings: unknown }): boolean {
  if (isVenueEnabledFor(event)) return true;
  return isVenueModuleEnabled() && readVenueOpen(event.settings) && !!readVenueRooms(event.settings);
}

export type EventLayout = { kind: "preset" } | { kind: "generated"; layout: VenueLayout } | { kind: "broken"; issues: string[] };

/** The event's generated venue, EHC's preset when it has no saved rooms, or "broken" when the saved rooms no longer make a walkable building. */
export function eventLayout(event: { id: string; name: string; settings: unknown }): EventLayout {
  const saved = readVenueRooms(event.settings);
  if (!saved || !isVenueModuleEnabled()) return { kind: "preset" };
  const layout = generateLayout(saved.rooms, { eventName: event.name });
  const check = checkLayout(layout);
  if (check.ok) return { kind: "generated", layout };
  apiLogger.error({ msg: "venue:layout-not-walkable", eventId: event.id, issues: check.issues });
  return { kind: "broken", issues: check.issues };
}

/** The rooms sessions can be in: a generated venue's own (the corridor is no room), else EHC's. */
export function venueRooms(built: EventLayout): VenueRoomRef[] {
  if (built.kind === "generated") return built.layout.zones.filter((z) => z.kind !== "corridor").map((z) => ({ id: z.id, name: z.name }));
  return Object.entries(vocab.ZONE_NAMES as Record<string, string>).map(([id, name]) => ({ id, name }));
}

/** How many stands carry sponsors: a generated exhibition's stands (EHC's hand-built booths stay as they are). */
export function sponsorStands(built: EventLayout): number {
  return built.kind === "generated" ? built.layout.items.filter((it) => it.t === "stand").length : 0;
}
