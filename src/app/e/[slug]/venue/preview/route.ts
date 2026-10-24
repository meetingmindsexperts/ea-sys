/**
 * POST /e/:slug/venue/preview: walk an unsaved floor plan in 3D
 * (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, phase 2, "Preview in 3D").
 *
 * The floor plan editor posts its plan here as a form (field `plan`, JSON)
 * into a new tab. The event team only (`events.update`, venueGuard's
 * `preview`), with the venue module on and the rooms saved; the venue need not
 * be opened yet. The plan is checked exactly as a save would check it (schema,
 * plan shape, the building it makes, walkability) and nothing is stored. The
 * page runs offline (lib/venue/venue-page.ts): no live colleagues, AI
 * attendees, activity or reports, and a strip says it is a preview.
 *
 * Same-origin only (isSameOriginRequest: Origin or Referer against Host): a
 * form from another site is refused (403), since the session cookie would
 * otherwise let it render a plan of its choosing here.
 * 60 previews an hour per person.
 */
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, isSameOriginRequest } from "@/lib/security";
import { venueGuard } from "@/lib/venue/route-guard";
import { readVenueRooms, type VenueRoom } from "@/lib/venue/rooms";
import { planIssues, planSchema, type VenuePlan } from "@/lib/venue/plan";
import type { VenueLayout } from "@/lib/venue/layout";
import { layoutFromPlan } from "@/lib/venue/plan-layout";
import { checkLayout } from "@/lib/venue/layout-check";
import { plainVenuePage, venuePageResponse } from "@/lib/venue/venue-page";

type Params = { params: Promise<{ slug: string }> };

const ROUTE = "venue:preview";
const PREVIEWS_PER_HOUR = 60;
/** A plan of 20 rooms and 12 walkways is a few kilobytes; anything near this is not one. */
const MAX_PLAN_CHARS = 100_000;
/** The form body around it (URL-encoded JSON is about three times its length). */
const MAX_BODY_BYTES = 400_000;

/** The save's checks, in its order: the plan's shape, the building it makes, then walkability. */
function walkable(rooms: VenueRoom[], plan: VenuePlan, eventName: string): { ok: true; layout: VenueLayout } | { ok: false; issues: string[] } {
  const shape = planIssues(rooms, plan);
  if (shape.length) return { ok: false, issues: shape };
  const built = layoutFromPlan(rooms, plan, { eventName });
  if (built.issues.length) return { ok: false, issues: built.issues };
  const check = checkLayout(built.layout);
  if (!check.ok) return { ok: false, issues: check.issues };
  return { ok: true, layout: built.layout };
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { slug } = await params;
    // Origin (or Referer) against the Host nginx forwards: the proxy's own model, which holds behind
    // nginx where req.url is the container's address, on any host name the site answers on.
    const origin = isSameOriginRequest(req);
    if (!origin.ok) {
      apiLogger.warn({ msg: `${ROUTE}:cross-origin`, slug, reason: origin.reason, origin: req.headers.get("origin") });
      return plainVenuePage(403);
    }
    // A plan is a few kilobytes: refuse a large body before reading it.
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) {
      apiLogger.warn({ msg: `${ROUTE}:too-large`, slug, bytes: length });
      return plainVenuePage(413);
    }
    const gate = await venueGuard({ slug }, ROUTE, { preview: true });
    if (!gate.ok) return plainVenuePage(gate.response.status);
    const e = gate.event;
    const ctx = { userId: gate.userId, eventId: e.id };

    const limit = checkRateLimit({ key: `venue-preview:${gate.userId}`, limit: PREVIEWS_PER_HOUR, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      apiLogger.warn({ msg: `${ROUTE}:rate-limited`, ...ctx, retryAfterSeconds: limit.retryAfterSeconds });
      return plainVenuePage(429, { headers: { "Retry-After": String(limit.retryAfterSeconds) } });
    }

    const raw = (await req.formData().catch(() => null))?.get("plan");
    if (typeof raw !== "string") {
      apiLogger.warn({ msg: `${ROUTE}:no-plan`, ...ctx });
      return plainVenuePage(400);
    }
    if (raw.length > MAX_PLAN_CHARS) {
      apiLogger.warn({ msg: `${ROUTE}:too-large`, ...ctx, chars: raw.length });
      return plainVenuePage(413);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      apiLogger.warn({ msg: `${ROUTE}:not-json`, ...ctx });
      return plainVenuePage(400);
    }
    const parsed = planSchema.safeParse(json);
    if (!parsed.success) {
      const issues = [...new Set(parsed.error.issues.map((i) => i.message))];
      apiLogger.warn({ msg: `${ROUTE}:invalid-plan`, ...ctx, issues });
      return plainVenuePage(400, { message: "This plan cannot be previewed:", reasons: issues });
    }

    const built = walkable(readVenueRooms(e.settings)?.rooms ?? [], parsed.data, e.name);
    if (!built.ok) {
      apiLogger.warn({ msg: `${ROUTE}:not-walkable`, ...ctx, issues: built.issues });
      return plainVenuePage(422, { message: "This plan cannot be walked yet. Fix these in the editor first:", reasons: built.issues });
    }

    const page = await venuePageResponse(gate, { kind: "generated", layout: built.layout }, { preview: true });
    apiLogger.info({ msg: `${ROUTE}:opened`, ...ctx, rooms: parsed.data.rooms.length, walkways: parsed.data.corridors.length, sessions: page.sessions, sponsors: page.sponsors });
    return page.response;
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return plainVenuePage(500);
  }
}
