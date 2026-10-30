/**
 * GET the event's venue floor plan as a PDF (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * section 3.7): drawn from the SAVED rooms, the same layout the walkable venue
 * is built from, with each stand's sponsor in the venue's own order.
 *
 *   ?paper=A3 (default) | A4
 *
 * ACCESS: `events.read`, like the plan on the Venue tab (owner, F8); the event
 * lookup is `gate.eventWhere`. 404 while VENUE_MODULE_ENABLED is off. 30
 * renders an hour per person: pdfkit runs on the box that serves the door.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { isVenueModuleEnabled } from "@/lib/module-flags";
import { readVenuePlan } from "@/lib/venue/plan";
import { buildVenueLayout } from "@/lib/venue/plan-layout";
import { checkLayout } from "@/lib/venue/layout-check";
import { readVenueRooms } from "@/lib/venue/rooms";
import { PLAN_PAPERS, planDateLine, renderFloorPlanPdf, type PlanPaper } from "@/lib/venue/floor-plan-pdf";
import { loadVenueProgramme } from "@/services/venue-programme-service";

type RouteParams = { params: Promise<{ eventId: string }> };
const ROUTE = "events/[eventId]/venue/plan-pdf:GET";
const RENDERS_PER_HOUR = 30;

const fail = (error: string, status: number, code?: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ error, ...(code && { code }) }, { status, headers });

/** "Atlantis, Dubai, United Arab Emirates", with a repeated part ("Dubai, Dubai") said once. */
function placeLine(...parts: (string | null)[]): string | null {
  const seen = new Set<string>();
  const kept = parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .filter((p) => (seen.has(p.toLowerCase()) ? false : (seen.add(p.toLowerCase()), true)));
  return kept.length ? kept.join(", ") : null;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!isVenueModuleEnabled()) {
      apiLogger.warn({ msg: `${ROUTE}:module-off`, eventId });
      return fail("Not found", 404);
    }
    if (!session?.user) {
      apiLogger.warn({ msg: `${ROUTE}:unauthorized`, eventId });
      return fail("Unauthorized", 401);
    }
    const gate = requirePermission(session, "events.read", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const paperParam = new URL(req.url).searchParams.get("paper") ?? "A3";
    if (!PLAN_PAPERS.includes(paperParam as PlanPaper)) {
      apiLogger.warn({ msg: `${ROUTE}:invalid-paper`, eventId, userId: session.user.id, paper: paperParam });
      return fail("Paper must be A3 or A4", 400, "INVALID_PAPER");
    }
    const paper = paperParam as PlanPaper;

    const limit = checkRateLimit({ key: `venue-plan-pdf:${session.user.id}`, limit: RENDERS_PER_HOUR, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      apiLogger.warn({ msg: `${ROUTE}:rate-limited`, eventId, userId: session.user.id, retryAfterSeconds: limit.retryAfterSeconds });
      return fail(`You can download the plan ${RENDERS_PER_HOUR} times an hour. Try again later.`, 429, "RATE_LIMITED", {
        "Retry-After": String(limit.retryAfterSeconds),
      });
    }

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, slug: true, organizationId: true, settings: true, startDate: true, endDate: true, timezone: true, venue: true, city: true, country: true },
    });
    if (!event?.organizationId) {
      apiLogger.warn({ msg: `${ROUTE}:event-not-found`, eventId, userId: session.user.id });
      return fail("Not found", 404);
    }
    const organizationId = event.organizationId;

    return await runWithTenant(organizationId, async () => {
      const saved = readVenueRooms(event.settings);
      if (!saved) {
        apiLogger.warn({ msg: `${ROUTE}:no-rooms`, eventId, userId: session.user.id });
        return fail("Save the venue's rooms first; the PDF is drawn from the saved rooms.", 409, "NO_ROOMS");
      }
      // The drawn plan when there is one that still fits the rooms, else the automatic one: what the venue shows.
      const built = buildVenueLayout(saved.rooms, readVenuePlan(event.settings)?.plan ?? null, { eventName: event.name });
      if (built.planIssues.length) apiLogger.warn({ msg: `${ROUTE}:plan-not-used`, eventId, issues: built.planIssues });
      const layout = built.layout;
      const check = checkLayout(layout);
      if (!check.ok) {
        apiLogger.error({ msg: `${ROUTE}:layout-not-walkable`, eventId, issues: check.issues });
        return fail("The saved rooms no longer make a walkable plan. Open the Venue tab and save the rooms again.", 409, "LAYOUT_BROKEN");
      }

      const rooms = layout.zones.filter((z) => z.kind !== "corridor").map((z) => ({ id: z.id, name: z.name }));
      const programme = await loadVenueProgramme({ organizationId, eventId: event.id }, rooms, event.timezone);
      const place = placeLine(event.venue, event.city, event.country);
      const pdf = await renderFloorPlanPdf({
        layout,
        eventName: event.name,
        dateLine: planDateLine(event.startDate, event.endDate, event.timezone),
        place,
        sponsors: programme.sponsors,
        paper,
        generatedAt: new Date(),
      });
      apiLogger.info({ msg: `${ROUTE}:rendered`, eventId, userId: session.user.id, paper, bytes: pdf.length, rooms: rooms.length });
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${event.slug}-floor-plan-${paper}.pdf"`,
          "Cache-Control": "private, no-store",
        },
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return fail("Failed to make the floor plan PDF", 500);
  }
}
