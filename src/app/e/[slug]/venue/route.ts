/**
 * GET /e/:slug/venue: the event's walkable online venue (plan phase 4).
 *
 * Staff preview (owner, Oct 8, 2026): staff who can see the event, for events
 * named in VENUE_EVENT_SLUGS or whose rooms the event team saved and opened on
 * the Venue tab (phase 6). Saved rooms are sent as the venue's layout
 * (window.EHC_LAYOUT), generated and checked walkable on every load. Served as the vendor built it
 * (vendor/ehc-venue), built by lib/venue/venue-page.ts, which the preview of
 * an unsaved floor plan (./preview) shares.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { venueGuard } from "@/lib/venue/route-guard";
import { eventLayout } from "@/lib/venue/event-venue";
import { plainVenuePage, venuePageResponse } from "@/lib/venue/venue-page";

type Params = { params: Promise<{ slug: string }> };

const ROUTE = "venue:page";

export async function GET(req: Request, { params }: Params) {
  try {
    const { slug } = await params;
    const gate = await venueGuard({ slug }, ROUTE);
    if (!gate.ok && gate.response.status === 401) {
      // Behind nginx req.url carries the container's origin; the public URL wins.
      const login = new URL("/login", process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin);
      login.searchParams.set("callbackUrl", `/e/${encodeURIComponent(slug)}/venue`);
      return NextResponse.redirect(login);
    }
    if (!gate.ok) return plainVenuePage(gate.response.status);

    const e = gate.event;
    const built = eventLayout(e);
    if (built.kind === "broken") return plainVenuePage(503);
    const page = await venuePageResponse(gate, built);
    apiLogger.info({ msg: `${ROUTE}:opened`, userId: gate.userId, eventId: e.id, team: gate.team, venue: built.kind, sessions: page.sessions, sponsors: page.sponsors });
    return page.response;
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return plainVenuePage(500);
  }
}
