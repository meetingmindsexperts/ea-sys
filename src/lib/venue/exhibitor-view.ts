/**
 * What the exhibitor floor plan shows (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, section 10, G2 and G7): the venue as
 * the team drew it, minus everything that is for the team alone. Built on the server, so nothing private ever
 * reaches the exhibitor's browser to be hidden there.
 *
 * - Staff-only fixtures (the AV console, anything ticked "Staff only") are dropped before the layout is built,
 *   so they leave no item, no label and no gap in the stand numbering.
 * - Staff notes never leave the server.
 * - A venue drawing goes to exhibitors only where the team ticked "Show to exhibitors" (G7, off by default).
 * - The layout's people and visit points (the 3D venue's) are left out: the map does not need them.
 */
import type { Rect, VenueLayout } from "./layout";
import { underlayRect } from "./underlay";
import { isInternal, type PlanUnderlay, type VenuePlan } from "./plan";
import { buildVenueLayout } from "./plan-layout";
import type { VenueRoom } from "./rooms";

/** The plan an exhibitor's map is built from. */
export function exhibitorPlan(plan: VenuePlan): VenuePlan {
  const fixtures = plan.fixtures.filter((f) => !isInternal(f)).map(({ note: _note, internal: _internal, ...f }) => {
    void _note;
    void _internal;
    return f;
  });
  const underlays = (plan.underlays ?? []).filter((u) => u.exhibitors);
  const { underlays: _all, ...rest } = plan;
  void _all;
  return { ...rest, fixtures, ...(underlays.length && { underlays }) };
}

export interface ExhibitorMap {
  layout: Pick<VenueLayout, "zones" | "walls" | "doors" | "items" | "bounds" | "levels">;
  /** The drawings shown behind the plan, by floor (absent: none ticked for exhibitors). */
  underlays: PlanUnderlay[];
  /** Where each of those drawings lies on the map, in the map's own coordinates (floors stand side by side there). */
  drawings: { floor: string; rect: Rect; opacity: number }[];
}

/**
 * A drawing is placed in its floor's own coordinates; the venue puts the floors side by side, so a drawing moves
 * as far as that floor's rooms moved. Measured from any room on the floor, which all move together.
 */
function placeDrawings(layout: VenueLayout, plan: VenuePlan | null, underlays: PlanUnderlay[]) {
  return underlays.flatMap((u) => {
    const floor = u.floor ?? "ground";
    const room = plan?.rooms.find((p) => (p.floor ?? "ground") === floor);
    const zone = room && layout.zones.find((z) => z.id === room.id);
    if (!room || !zone) return [];
    const dx = zone.rect[0] - room.rect[0];
    const dz = zone.rect[1] - room.rect[1];
    const [x0, z0, x1, z1] = underlayRect(u);
    return [{ floor, rect: [x0 + dx, z0 + dz, x1 + dx, z1 + dz] as Rect, opacity: u.opacity }];
  });
}

/** The whole layout an exhibitor may see (the exhibitor PDF draws it), with the drawings ticked for exhibitors. */
export function exhibitorLayout(rooms: VenueRoom[], plan: VenuePlan | null, eventName: string): { layout: VenueLayout; underlays: PlanUnderlay[] } {
  const shown = plan ? exhibitorPlan(plan) : null;
  return { layout: buildVenueLayout(rooms, shown, { eventName }).layout, underlays: shown?.underlays ?? [] };
}

/** The exhibitor's map: the saved rooms and plan, filtered; the automatic venue when there is no drawn plan. */
export function exhibitorMap(rooms: VenueRoom[], plan: VenuePlan | null, eventName: string): ExhibitorMap {
  const { layout, underlays } = exhibitorLayout(rooms, plan, eventName);
  const drawings = placeDrawings(layout, plan, underlays);
  const { zones, walls, doors, items, bounds, levels } = layout;
  return {
    layout: { zones, walls, doors, items, bounds, ...(levels && { levels }) },
    underlays,
    drawings,
  };
}

/** The exhibitor link's path on the event's public pages. */
export const floorPlanSharePath = (slug: string, token: string) => `/e/${encodeURIComponent(slug)}/floor-plan/${encodeURIComponent(token)}`;
