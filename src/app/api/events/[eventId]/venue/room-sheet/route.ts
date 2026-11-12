/**
 * GET one room's setup sheet as a PDF (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, section 11, step 3): the room to scale
 * with its stage, screen, seating, doors and headcount, drawn from the SAVED rooms, the same layout the walkable
 * venue and the floor plan PDF are built from.
 *
 *   ?room=<room id>
 *
 * ACCESS: `events.read`, like the floor plan PDF; the event lookup is `gate.eventWhere`. 404 while
 * VENUE_MODULE_ENABLED is off. Shares the floor plan PDF's 30 renders an hour per person: pdfkit runs on the box
 * that serves the door.
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
import { ROOM_ID, SEATED_KINDS, readVenueRooms } from "@/lib/venue/rooms";
import { checkLayout } from "@/lib/venue/layout-check";
import { planDateLine } from "@/lib/venue/floor-plan-pdf";
import { renderRoomSheetPdf, roomFilePart } from "@/lib/venue/room-sheet-pdf";
import { contentDisposition } from "@/lib/download-filename";

type RouteParams = { params: Promise<{ eventId: string }> };
const ROUTE = "events/[eventId]/venue/room-sheet:GET";
const RENDERS_PER_HOUR = 30;

const fail = (error: string, status: number, code?: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ error, ...(code && { code }) }, { status, headers });

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

    const roomId = new URL(req.url).searchParams.get("room") ?? "";
    if (!ROOM_ID.test(roomId)) {
      apiLogger.warn({ msg: `${ROUTE}:invalid-room`, eventId, userId: session.user.id });
      return fail("Choose a room", 400, "INVALID_ROOM");
    }

    // The same bucket as the floor plan PDF: one budget for the venue's PDFs.
    const limit = checkRateLimit({ key: `venue-plan-pdf:${session.user.id}`, limit: RENDERS_PER_HOUR, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      apiLogger.warn({ msg: `${ROUTE}:rate-limited`, eventId, userId: session.user.id, retryAfterSeconds: limit.retryAfterSeconds });
      return fail(`You can download the venue's PDFs ${RENDERS_PER_HOUR} times an hour. Try again later.`, 429, "RATE_LIMITED", {
        "Retry-After": String(limit.retryAfterSeconds),
      });
    }

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, slug: true, organizationId: true, settings: true, startDate: true, endDate: true, timezone: true, venue: true, city: true },
    });
    if (!event?.organizationId) {
      apiLogger.warn({ msg: `${ROUTE}:event-not-found`, eventId, userId: session.user.id });
      return fail("Not found", 404);
    }

    return await runWithTenant(event.organizationId, async () => {
      const saved = readVenueRooms(event.settings);
      if (!saved) {
        apiLogger.warn({ msg: `${ROUTE}:no-rooms`, eventId, userId: session.user.id });
        return fail("Save the venue's rooms first; the sheet is drawn from the saved rooms.", 409, "NO_ROOMS");
      }
      const room = saved.rooms.find((r) => r.id === roomId);
      if (!room) {
        apiLogger.warn({ msg: `${ROUTE}:room-not-found`, eventId, userId: session.user.id, roomId });
        return fail("That room is not in the saved rooms. Save the rooms and try again.", 404, "ROOM_NOT_FOUND");
      }
      // A setup sheet is for a room people sit in, as the menu offers (review of f10bdb84).
      if (!SEATED_KINDS.includes(room.kind)) {
        apiLogger.warn({ msg: `${ROUTE}:room-not-seated`, eventId, userId: session.user.id, roomId, kind: room.kind });
        return fail("A setup sheet is for a room people sit in: the plenary, a hall or a workshop.", 400, "ROOM_NOT_SEATED");
      }
      const built = buildVenueLayout(saved.rooms, readVenuePlan(event.settings)?.plan ?? null, { eventName: event.name });
      if (built.planIssues.length) apiLogger.warn({ msg: `${ROUTE}:plan-not-used`, eventId, issues: built.planIssues });
      const check = checkLayout(built.layout);
      if (!check.ok) {
        apiLogger.error({ msg: `${ROUTE}:layout-not-walkable`, eventId, issues: check.issues });
        return fail("The saved rooms no longer make a walkable plan. Open the Venue tab and save the rooms again.", 409, "LAYOUT_BROKEN");
      }
      const place = [event.venue, event.city].map((p) => p?.trim()).filter(Boolean).join(", ") || null;
      const pdf = await renderRoomSheetPdf({
        layout: built.layout,
        zoneId: room.id,
        eventName: event.name,
        dateLine: planDateLine(event.startDate, event.endDate, event.timezone),
        place,
        generatedAt: new Date(),
      });
      apiLogger.info({ msg: `${ROUTE}:rendered`, eventId, userId: session.user.id, roomId, bytes: pdf.length });
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": contentDisposition(`${event.slug}-${roomFilePart(room.name)}-setup.pdf`),
          "Cache-Control": "private, no-store",
        },
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return fail("The room sheet could not be made. Please try again.", 500);
  }
}
