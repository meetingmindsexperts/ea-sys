import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { findPublicEvent } from "@/lib/tenant/event-tenant";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { agendaPayload, isAgendaPublished, loadAgendaEvent } from "@/lib/agenda-data";
import { AGENDA_PUBLIC_EVENT_STATUSES } from "@/lib/agenda-display";
import { getSessionRolesForDisplay } from "@/services/session-role-service";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

/**
 * "No such event" and "the agenda is not live yet" are both a 404 to a
 * browser; the code tells the page which message to show.
 */
function notAvailable(code: "EVENT_NOT_FOUND" | "AGENDA_NOT_PUBLISHED", error: string) {
  return NextResponse.json({ error, code }, { status: 404 });
}

/**
 * No public event answers to this slug. Logged at info, not warn: an old link
 * to a deleted or finished event is opened again and again, and warn fills the
 * SystemLog table (one deleted event drew 986 analytics warnings in a week).
 */
function noPublicEvent(slug: string) {
  apiLogger.info({ slug }, "public-agenda:no-public-event");
  return notAvailable("EVENT_NOT_FOUND", "Event not found");
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);
    // 600 a minute, not 120 (Nov 9, 2026): the agenda is what a venue audience
    // opens at every session change, all from the venue's one Wi-Fi address.
    // The browser caches it for 60s, so each attendee costs about one request
    // a minute; nginx's 100 r/s per IP stays the flood backstop.
    const ipRateLimit = checkRateLimit({
      key: `public-agenda:ip:${clientIp}`,
      limit: 600,
      windowMs: 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      apiLogger.warn({ msg: "public/agenda:rate-limited", retryAfterSeconds: ipRateLimit.retryAfterSeconds, ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const { slug } = await params;

    // Resolve the tenant BEFORE reading anything policied.
    //
    // `findPublicEvent` reads the slim row inside the lane of the organisation
    // the host names (Event carries a row policy since Nov 17, 2026). Everything
    // below reads tables that are policied too (TicketType, PricingTier,
    // EventSession, PromoCode), and under RLS a query outside a tenant lane
    // returns zero rows rather than an error. This route previously did the event lookup
    // and those policied includes in ONE query, so on the platform the event
    // resolved fine and its registration types came back EMPTY — every public
    // event page would have read "Registration Closed" with nothing in the
    // logs. Found in the two-tenant sandbox, Aug 21 2026.
    const scope = await findPublicEvent(req, slug, {
        allowIdFallback: true,
        statuses: [...AGENDA_PUBLIC_EVENT_STATUSES],
      }, {
      select: { id: true, organizationId: true },
    });

    if (!scope) return noPublicEvent(slug);

    return await runWithTenant(scope.organizationId, async () => {
    const event = await loadAgendaEvent(scope.id);

    if (!event) {
      apiLogger.warn({ slug }, "public-agenda:event-not-found");
      return notAvailable("EVENT_NOT_FOUND", "Event not found");
    }

    // Check if the agenda has been published by the organizer
    if (!isAgendaPublished(event.settings)) {
      apiLogger.warn({ slug, eventId: event.id }, "public-agenda:not-published");
      return notAvailable("AGENDA_NOT_PUBLISHED", "Agenda not published yet");
    }

    const response = NextResponse.json(agendaPayload(event, await getSessionRolesForDisplay(event.organizationId)));

    response.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching public agenda" });
    return NextResponse.json({ error: "Failed to fetch agenda" }, { status: 500 });
  }
}
