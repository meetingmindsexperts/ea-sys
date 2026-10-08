/**
 * GET /e/:slug/venue: the event's walkable online venue (plan phase 4).
 *
 * Staff preview (owner, Oct 8, 2026): staff who can see the event, and only
 * for events named in VENUE_EVENT_SLUGS. Served as the vendor built it
 * (vendor/ehc-venue, generated into page-html.generated.json), after three
 * small scripts: the event's real name, dates and venue (window.EHC_EVENT),
 * its recordings per screen (window.EHC_SCREENS),
 * this person's runtime settings (window.EHC_VENUE), and the EA-SYS runtime
 * the vendor code talks to (/venue-runtime.js).
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { venueGuard } from "@/lib/venue/route-guard";
import { venueDisplayName } from "@/lib/venue/display-name";
import { venueDateRange } from "@/lib/venue/date-range";
import { resolveTimezone } from "@/lib/event-time";
import { VENUE_SAFETY_INBOX, readVenueConfig } from "@/services/venue-service";
import venuePage from "@/lib/venue/page-html.generated.json";

type Params = { params: Promise<{ slug: string }> };

const ROUTE = "venue:page";

/** A value as a script literal that can never close the <script> it sits in. */
const literal = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const MESSAGES: Record<number, string> = { 403: "You do not have access to this venue.", 404: "Not found." };

function plainPage(status: number): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Online venue</title><p style="font:16px system-ui;margin:2rem">${MESSAGES[status] ?? "Something went wrong."}</p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

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
    if (!gate.ok) return plainPage(gate.response.status);

    const e = gate.event;
    const ehcEvent = {
      name: e.name,
      date: venueDateRange(e.startDate, e.endDate, resolveTimezone(e.timezone)),
      ...(e.venue && { venue: e.venue }),
    };
    // Recordings per screen from the event's settings; an empty map stops the
    // vendor page looking for a screens.json beside itself (it would 404).
    const screens = readVenueConfig(e.settings).screens ?? {};
    const ehcVenue = { api: `/api/venue/${e.id}`, userId: gate.userId, name: venueDisplayName(gate.session), team: gate.team };
    const page =
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      "<style>body{margin:0}[hidden]{display:none!important}</style></head><body>" +
      `<script>window.EHC_EVENT=${literal(ehcEvent)};window.EHC_VENUE=${literal(ehcVenue)};window.EHC_CONTACT=${literal(VENUE_SAFETY_INBOX)};window.EHC_SCREENS=${literal(screens)};</script>` +
      '<script src="/venue-runtime.js"></script>' +
      venuePage.html +
      "</body></html>";
    apiLogger.info({ msg: `${ROUTE}:opened`, userId: gate.userId, eventId: e.id, team: gate.team });
    return new NextResponse(page, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return plainPage(500);
  }
}
