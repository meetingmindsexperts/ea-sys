/**
 * The public side of the exhibitor floor plan link (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10): one check
 * shared by the map, its PDF and its drawing, so they cannot drift. No sign-in: the secret link is the key.
 *
 * The event resolves from the slug first (its org opens the tenant lane), then the link by token, which must be
 * this event's and switched on. An unknown token, another event's token and a switched-off link all answer the
 * same 404, so the response never says which; each refusal is logged. Rate-limited per IP.
 *
 * Server only.
 */
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant, publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { isPlausibleShareToken } from "@/lib/share-token";
import { isVenueModuleEnabled } from "@/lib/module-flags";
import { runWithTenant } from "@/lib/tenant-context";
import { readVenuePlan, type StoredVenuePlan } from "./plan";
import { readVenueRooms, type StoredVenueRooms } from "./rooms";

export const FLOOR_PLAN_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export const FLOOR_PLAN_EVENT_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  slug: true,
  startDate: true,
  endDate: true,
  timezone: true,
  venue: true,
  city: true,
  country: true,
  bannerImage: true,
  bannerImageMobile: true,
  settings: true,
  organization: { select: { name: true, logo: true, settings: true } },
} as const;

export type FloorPlanEvent = Prisma.EventGetPayload<{ select: typeof FLOOR_PLAN_EVENT_SELECT }> & { organizationId: string };

export function inactive(): NextResponse {
  return NextResponse.json({ error: "This floor plan link is no longer active. Ask the organiser for a new one.", code: "LINK_INACTIVE" }, { status: 404, headers: FLOOR_PLAN_HEADERS });
}

export interface ResolvedLink {
  event: FloorPlanEvent;
  rooms: StoredVenueRooms;
  plan: StoredVenuePlan | null;
}

/**
 * Check the request and the link; on success, run `then` inside the event's tenant lane with the saved rooms and
 * plan. `bucket` names the rate limit (each door its own).
 */
export async function withFloorPlanLink(
  req: Request,
  slug: string,
  token: string,
  door: { route: string; bucket: string; limit: number; windowMs: number },
  then: (link: ResolvedLink) => Promise<NextResponse>,
): Promise<NextResponse> {
  if (!isVenueModuleEnabled()) {
    apiLogger.warn({ msg: `${door.route}:module-off`, slug });
    return inactive();
  }
  const ip = getClientIp(req);
  const limit = checkRateLimit({ key: `${door.bucket}:ip:${ip}`, limit: door.limit, windowMs: door.windowMs });
  if (!limit.allowed) {
    apiLogger.warn({ msg: `${door.route}:rate-limited`, slug, ip, retryAfterSeconds: limit.retryAfterSeconds });
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly.", code: "RATE_LIMITED", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { ...FLOOR_PLAN_HEADERS, "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }
  if (!isPlausibleShareToken(token)) {
    apiLogger.warn({ msg: `${door.route}:malformed-token`, slug });
    return inactive();
  }
  // Event carries no RLS policy, so this lookup runs before any lane; any status, as sharing is the team's choice.
  const event = await db.event.findFirst({ where: await publicEventWhere(req, slug), select: FLOOR_PLAN_EVENT_SELECT });
  if (!event?.organizationId) {
    apiLogger.warn({ msg: `${door.route}:event-not-found`, slug });
    return inactive();
  }
  const organizationId = event.organizationId;
  return runWithTenant(organizationId, async () => {
    const link = await db.venueShareLink.findUnique({ where: { token }, select: { id: true, eventId: true, enabled: true } });
    if (!link || link.eventId !== event.id) {
      apiLogger.warn({ msg: `${door.route}:invalid-token`, slug, eventId: event.id });
      return inactive();
    }
    if (!(await eventMatchesRequestTenant(req, organizationId))) {
      apiLogger.warn({ msg: `${door.route}:tenant-mismatch`, slug, linkId: link.id });
      return inactive();
    }
    if (!link.enabled) {
      apiLogger.warn({ msg: `${door.route}:link-disabled`, slug, linkId: link.id });
      return inactive();
    }
    const rooms = readVenueRooms(event.settings);
    if (!rooms) {
      apiLogger.warn({ msg: `${door.route}:no-rooms`, slug, eventId: event.id });
      return NextResponse.json({ error: "The floor plan is not ready yet. Please check back later.", code: "NOT_READY" }, { status: 409, headers: FLOOR_PLAN_HEADERS });
    }
    return then({ event: { ...event, organizationId }, rooms, plan: readVenuePlan(event.settings) });
  });
}
