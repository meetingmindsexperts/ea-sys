/**
 * The event's online venue rooms (docs/EVENT_BLUEPRINT_PLAN.md, D9).
 *
 *   GET → the saved room list (or null) and its version.
 *   PUT { rooms, version } → save it; 409 STALE_VERSION when someone saved in
 *         between, 400 INVALID_ROOMS with every reason when the floor plan
 *         cannot lay it out.
 *
 * ACCESS: `events.read` to look, `events.update` to save; the event lookup is
 * `gate.eventWhere`. The whole route answers 404 while VENUE_MODULE_ENABLED is
 * off.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";
import { isVenueModuleEnabled } from "@/lib/module-flags";
import { readVenueRooms } from "@/lib/venue/rooms";
import { saveVenueRooms } from "@/services/venue-rooms-service";

type RouteParams = { params: Promise<{ eventId: string }> };

const putSchema = z.object({
  rooms: z.array(z.unknown()).max(50),
  version: z.number().int().min(0),
});

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(_req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/venue:GET";
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!isVenueModuleEnabled()) {
      apiLogger.warn({ msg: `${ROUTE}:module-off`, eventId });
      return notFound();
    }
    if (!session?.user) {
      apiLogger.warn({ msg: `${ROUTE}:unauthorized`, eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "events.read", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;
    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, organizationId: true, settings: true } });
    if (!event?.organizationId) {
      apiLogger.warn({ msg: `${ROUTE}:event-not-found`, eventId, userId: session.user.id });
      return notFound();
    }
    return await runWithTenant(event.organizationId, async () => {
      const saved = readVenueRooms(event.settings);
      return NextResponse.json({ rooms: saved?.rooms ?? null, version: saved?.updatedAt ?? 0 }, { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load the venue" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/venue:PUT";
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!isVenueModuleEnabled()) {
      apiLogger.warn({ msg: `${ROUTE}:module-off`, eventId });
      return notFound();
    }
    if (!session?.user) {
      apiLogger.warn({ msg: `${ROUTE}:unauthorized`, eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "events.update", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;
    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, organizationId: true } });
    if (!event?.organizationId) {
      apiLogger.warn({ msg: `${ROUTE}:event-not-found`, eventId, userId: session.user.id });
      return notFound();
    }
    const organizationId = event.organizationId;
    return await runWithTenant(organizationId, async () => {
      const parsed = putSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, eventId, userId: session.user.id, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const res = await saveVenueRooms({ organizationId, eventId, userId: session.user.id }, parsed.data.rooms, parsed.data.version);
      if (!res.ok) {
        const status = res.code === "STALE_VERSION" ? 409 : 400;
        return NextResponse.json({ error: res.message, code: res.code, ...("issues" in res && { issues: res.issues }) }, { status });
      }
      return NextResponse.json({ rooms: res.saved.rooms, version: res.saved.updatedAt });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to save the venue" }, { status: 500 });
  }
}
