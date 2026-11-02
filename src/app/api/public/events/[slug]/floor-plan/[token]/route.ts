/**
 * The exhibitor floor plan, the public side (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10, G1, G2, G7).
 *
 *   GET /api/public/events/[slug]/floor-plan/[token]
 *     → the event's name and banner, when the plan last changed, the map (built on the server from the saved rooms
 *       and plan with staff-only fixtures and notes removed: exhibitor-view.ts), the sponsors in the venue's stand
 *       order, and each venue drawing ticked for exhibitors with where it lies.
 *
 * No sign-in; the checks are exhibitor-link.ts. `no-store`: a link switched off stops working at once.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { exhibitorMap } from "@/lib/venue/exhibitor-view";
import { FLOOR_PLAN_HEADERS, withFloorPlanLink } from "@/lib/venue/exhibitor-link";
import { loadVenueProgramme } from "@/services/venue-programme-service";

type RouteParams = { params: Promise<{ slug: string; token: string }> };
const ROUTE = "public-floor-plan";

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    return await withFloorPlanLink(req, slug, token, { route: ROUTE, bucket: "public-floor-plan", limit: 120, windowMs: 60_000 }, async ({ event, rooms, plan }) => {
      const map = exhibitorMap(rooms.rooms, plan?.plan ?? null, event.name);
      const zones = map.layout.zones.filter((z) => z.kind !== "corridor").map((z) => ({ id: z.id, name: z.name }));
      const programme = await loadVenueProgramme({ organizationId: event.organizationId, eventId: event.id }, zones, event.timezone);
      const updatedAt = Math.max(rooms.updatedAt, plan?.updatedAt ?? 0);
      const base = `/api/public/events/${encodeURIComponent(slug)}/floor-plan/${encodeURIComponent(token)}`;
      return NextResponse.json(
        {
          event: { name: event.name, startDate: event.startDate, endDate: event.endDate, timezone: event.timezone, bannerImage: event.bannerImage, bannerImageMobile: event.bannerImageMobile, organizationName: event.organization.name, venue: event.venue, city: event.city },
          updatedAt: new Date(updatedAt).toISOString(),
          layout: map.layout,
          sponsors: programme.sponsors.map((s) => ({ id: s.id, name: s.name, ...(s.tier && { tier: s.tier }) })),
          drawings: map.drawings.map((d) => ({ ...d, src: `${base}/drawing?floor=${d.floor}` })),
        },
        { headers: FLOOR_PLAN_HEADERS },
      );
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "The floor plan could not be loaded. Please try again." }, { status: 500, headers: FLOOR_PLAN_HEADERS });
  }
}
