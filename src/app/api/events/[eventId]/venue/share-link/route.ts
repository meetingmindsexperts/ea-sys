/**
 * The exhibitor floor plan link, the organiser side (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10, G1 and G6):
 * one secret, read-only link per event for every sponsor and exhibitor.
 *
 *   GET  → the link (or none yet): its path, whether it is on, who last changed it.
 *   POST { action: "create" | "replace" | "enable" | "disable" }
 *          create: a link when there is none (an existing one is returned as it is);
 *          replace: a new token, so the old link stops working at once;
 *          enable / disable: switch it on or off without changing the token.
 *
 * ACCESS: `events.read` to see it, `events.update` to change it; the event lookup is `gate.eventWhere`. 404 while
 * VENUE_MODULE_ENABLED is off. 30 changes an hour per person.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { isVenueModuleEnabled } from "@/lib/module-flags";
import { resolveShareEvent, userNames } from "@/lib/share-link-access";
import { newShareToken } from "@/lib/share-token";
import { floorPlanSharePath } from "@/lib/venue/exhibitor-view";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const ROUTE = "events/[eventId]/venue/share-link";
const CHANGES_PER_HOUR = 30;
const postSchema = z.object({ action: z.enum(["create", "replace", "enable", "disable"]) });

type LinkRow = { token: string; enabled: boolean; updatedAt: Date; updatedById: string };

async function view(link: LinkRow | null, slug: string) {
  if (!link) return { link: null };
  const names = await userNames([link.updatedById]);
  return {
    link: { path: floorPlanSharePath(slug, link.token), enabled: link.enabled, updatedAt: link.updatedAt.toISOString(), updatedBy: names.get(link.updatedById) ?? null },
  };
}

const LINK_SELECT = { token: true, enabled: true, updatedAt: true, updatedById: true } as const;

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!isVenueModuleEnabled()) {
      apiLogger.warn({ msg: `${ROUTE}:GET:module-off`, eventId });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!session?.user) {
      apiLogger.warn({ msg: `${ROUTE}:GET:unauthorized`, eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "events.read", { route: `${ROUTE}:GET`, eventId });
    if (!gate.ok) return gate.response;
    const found = await resolveShareEvent(session, `${ROUTE}:GET`, eventId, gate.eventWhere);
    if ("error" in found) return found.error;
    const { event } = found;
    return await runWithTenant(event.organizationId, async () => {
      const link = await db.venueShareLink.findUnique({ where: { eventId: event.id }, select: LINK_SELECT });
      return NextResponse.json(await view(link, event.slug));
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:GET:failed` });
    return NextResponse.json({ error: "The exhibitor link could not be loaded." }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!isVenueModuleEnabled()) {
      apiLogger.warn({ msg: `${ROUTE}:POST:module-off`, eventId });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!session?.user) {
      apiLogger.warn({ msg: `${ROUTE}:POST:unauthorized`, eventId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "events.update", { route: `${ROUTE}:POST`, eventId });
    if (!gate.ok) return gate.response;

    const parsed = postSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({ msg: `${ROUTE}:POST:invalid-input`, eventId, userId: session.user.id, errors: parsed.error.flatten().fieldErrors });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const limit = checkRateLimit({ key: `venue-share-link:${session.user.id}`, limit: CHANGES_PER_HOUR, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      apiLogger.warn({ msg: `${ROUTE}:POST:rate-limited`, eventId, userId: session.user.id, retryAfterSeconds: limit.retryAfterSeconds });
      return NextResponse.json(
        { error: `You can change the exhibitor link ${CHANGES_PER_HOUR} times an hour. Try again later.`, code: "RATE_LIMITED", retryAfterSeconds: limit.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const found = await resolveShareEvent(session, `${ROUTE}:POST`, eventId, gate.eventWhere);
    if ("error" in found) return found.error;
    const { event } = found;
    const { action } = parsed.data;
    const userId = session.user.id;

    return await runWithTenant(event.organizationId, async () => {
      const cur = await db.venueShareLink.findUnique({ where: { eventId: event.id }, select: LINK_SELECT });
      if (!cur && action !== "create") {
        apiLogger.warn({ msg: `${ROUTE}:POST:no-link`, eventId, userId, action });
        return NextResponse.json({ error: "Create the exhibitor link first.", code: "NO_LINK" }, { status: 409 });
      }
      let link: LinkRow | null = cur;
      if (!cur) {
        link = await db.venueShareLink.create({
          data: { eventId: event.id, organizationId: event.organizationId, token: newShareToken(), createdById: userId, updatedById: userId },
          select: LINK_SELECT,
        });
      } else if (action === "replace") {
        link = await db.venueShareLink.update({ where: { eventId: event.id }, data: { token: newShareToken(), enabled: true, updatedById: userId }, select: LINK_SELECT });
      } else if (action === "enable" || action === "disable") {
        link = await db.venueShareLink.update({ where: { eventId: event.id }, data: { enabled: action === "enable", updatedById: userId }, select: LINK_SELECT });
      }
      await db.auditLog
        .create({ data: { eventId: event.id, userId, action: "UPDATE", entityType: "VenueShareLink", entityId: event.id, changes: { action, source: "rest" } } })
        .catch((err: unknown) => apiLogger.error({ err, msg: `${ROUTE}:POST:audit-failed`, eventId }));
      apiLogger.info({ msg: `${ROUTE}:POST:${action}`, eventId, userId, enabled: link?.enabled });
      return NextResponse.json(await view(link, event.slug));
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:POST:failed` });
    return NextResponse.json({ error: "The exhibitor link could not be changed." }, { status: 500 });
  }
}
