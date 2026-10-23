/**
 * The event's online venue rooms (docs/EVENT_BLUEPRINT_PLAN.md, D9).
 *
 *   GET → the saved room list (or null), its version, whether the venue is
 *         open to staff, the event's slug (for the link to it), and its
 *         sessions and sponsor count (to show what lands in which room), and
 *         the approved Blueprint's spaces as rooms to start from (only with
 *         BLUEPRINT_MODULE_ENABLED and `blueprints.view`).
 *   PUT { rooms, version } → save it; 409 STALE_VERSION when someone saved in
 *         between, 400 INVALID_ROOMS with every reason when the floor plan
 *         cannot lay it out.
 *   PUT { open } → open the generated venue to staff, or close it; 409
 *         NO_ROOMS when opening with no saved rooms.
 *   PUT { plan, planVersion } → save a drawn floor plan, or with plan null go
 *         back to the automatic one (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md);
 *         409 STALE_VERSION / NO_ROOMS, 400 INVALID_PLAN with every reason.
 *   GET also returns the plan, its version, and whether the venue is using
 *         it ("drawn") or the automatic plan, with why when a saved plan no
 *         longer fits the rooms.
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
import { principalFromSession, requirePermission } from "@/lib/permissions/require-permission";
import { can } from "@/lib/permissions/can";
import { isBlueprintModuleEnabled, isVenueModuleEnabled } from "@/lib/module-flags";
import { readBlueprintSpaces, roomsFromBlueprint } from "@/lib/venue/blueprint-rooms";
import { readVenueOpen, readVenueRooms } from "@/lib/venue/rooms";
import { saveVenuePlan, saveVenueRooms, setVenueOpen } from "@/services/venue-rooms-service";
import { readVenuePlan } from "@/lib/venue/plan";
import { buildVenueLayout } from "@/lib/venue/plan-layout";
import { loadProgrammeSummary } from "@/services/venue-programme-service";

type RouteParams = { params: Promise<{ eventId: string }> };

const putSchema = z.union([
  z.object({ rooms: z.array(z.unknown()).max(50), version: z.number().int().min(0) }),
  z.object({ open: z.boolean() }),
  z.object({ plan: z.union([z.null(), z.record(z.string(), z.unknown())]), planVersion: z.number().int().min(0) }),
]);

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
    const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, slug: true, organizationId: true, settings: true } });
    if (!event?.organizationId) {
      apiLogger.warn({ msg: `${ROUTE}:event-not-found`, eventId, userId: session.user.id });
      return notFound();
    }
    const organizationId = event.organizationId;
    return await runWithTenant(organizationId, async () => {
      const saved = readVenueRooms(event.settings);
      // The sessions and sponsors the venue will place in these rooms (phase 6 step 4), and the
      // approved Blueprint's spaces as rooms to start from (step 5), for those who may see Blueprints.
      const showBlueprint = isBlueprintModuleEnabled() && can(principalFromSession(session), "blueprints.view");
      const [programme, bp] = await Promise.all([
        loadProgrammeSummary({ organizationId, eventId: event.id }),
        showBlueprint ? db.blueprint.findFirst({ where: { eventId: event.id, organizationId }, select: { id: true, title: true, ref: true, data: true } }) : null,
      ]);
      const read = bp ? readBlueprintSpaces(bp.data) : null;
      const blueprint = bp && read ? { id: bp.id, title: bp.title, ref: bp.ref, spaces: read.spaces.length, ...roomsFromBlueprint(read.spaces, read.attendance) } : null;
      const storedPlan = readVenuePlan(event.settings);
      const built = saved && storedPlan ? buildVenueLayout(saved.rooms, storedPlan.plan, { eventName: "" }) : null;
      const plan = storedPlan
        ? { plan: storedPlan.plan, version: storedPlan.updatedAt, mode: built?.mode ?? "automatic", issues: built?.planIssues ?? [] }
        : null;
      return NextResponse.json(
        { rooms: saved?.rooms ?? null, version: saved?.updatedAt ?? 0, open: readVenueOpen(event.settings), slug: event.slug, programme, blueprint, plan },
        { headers: { "Cache-Control": "private, no-store" } },
      );
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
      const caller = { organizationId, eventId, userId: session.user.id };
      if ("open" in parsed.data) {
        const opened = await setVenueOpen(caller, parsed.data.open);
        if (!opened.ok) return NextResponse.json({ error: opened.message, code: opened.code }, { status: 409 });
        return NextResponse.json({ open: opened.open });
      }
      if ("plan" in parsed.data) {
        const res = await saveVenuePlan(caller, parsed.data.plan, parsed.data.planVersion);
        if (!res.ok) {
          const status = res.code === "INVALID_PLAN" ? 400 : 409;
          return NextResponse.json({ error: res.message, code: res.code, ...("issues" in res && { issues: res.issues }) }, { status });
        }
        return NextResponse.json({ plan: res.saved?.plan ?? null, planVersion: res.saved?.updatedAt ?? 0 });
      }
      const res = await saveVenueRooms(caller, parsed.data.rooms, parsed.data.version);
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
