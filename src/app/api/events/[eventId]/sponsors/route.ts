import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, WEBINAR_STAFF_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { SPONSOR_TIERS } from "@/lib/webinar";
import { getSponsors } from "@/lib/sponsors";
import { saveSponsors, type SaveSponsorsErrorCode } from "@/services/sponsor-service";

type RouteParams = { params: Promise<{ eventId: string }> };

// ── Zod schema ─────────────────────────────────────────────────────
// PUT replaces the entire array — simpler than row-level CRUD and a
// good fit for a JSON settings field. The whole array is ~tens of rows
// at most, so shipping it whole costs nothing.

// Logo URLs can be either http(s):// (external CDN, Supabase Storage) or a
// relative /uploads/... path produced by the local file-storage provider.
// Reject anything else to prevent javascript: / data: URLs from landing
// on the public page.
const logoUrlSchema = z
  .string()
  .max(2000)
  .refine(
    (v) => v === "" || v.startsWith("http://") || v.startsWith("https://") || v.startsWith("/"),
    { message: "Logo URL must start with http://, https://, or / (relative path)" },
  )
  .optional()
  .or(z.literal(""));

// Website URLs must be absolute (http/https) — never relative and never
// protocol-less. Preventing blank values is intentional: a partial URL like
// "acme.com" silently breaks link rendering downstream.
const websiteUrlSchema = z
  .string()
  .max(2000)
  .refine(
    (v) => v === "" || v.startsWith("http://") || v.startsWith("https://"),
    { message: "Website URL must start with http:// or https://" },
  )
  .optional()
  .or(z.literal(""));

const sponsorEntrySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  logoUrl: logoUrlSchema,
  websiteUrl: websiteUrlSchema,
  tier: z.enum(SPONSOR_TIERS).optional(),
  description: z.string().max(2000).optional().or(z.literal("")),
  sortOrder: z.number().int().min(0).max(10_000),
});

const sponsorsPutSchema = z.object({
  sponsors: z.array(sponsorEntrySchema).max(200),
});

// ── GET — return the current sponsor list ────────────────────────

/** Exhaustive over the service's error union, so a new code fails the build. */
const HTTP_STATUS_FOR_SAVE_SPONSORS: Record<SaveSponsorsErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  INVALID_NAME: 400,
  INVALID_TIER: 400,
  DUPLICATE_NAME: 409,
  // 409, not 400: the payload is well-formed and the CONFLICT is with data the
  // organiser has not seen. The body carries `inUse` so the UI can say which.
  SPONSOR_IN_USE: 409,
  UNKNOWN: 500,
};

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Org-independent roles (REVIEWER / SUBMITTER / REGISTRANT) have a null
    // organizationId. Guard before the query: `organizationId: null` in the
    // where is a Prisma validation error (Event.organizationId is non-nullable),
    // which is exactly the 500 Sentry JAVASCRIPT-NEXTJS-1N caught. Fixes the
    // `organizationId!` footgun on this route.
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn(
        { userId: session.user.id, role: session.user.role, eventId },
        "sponsors:list-no-org",
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return NextResponse.json({ sponsors: await getSponsors(eventId) });
  } catch (err) {
    apiLogger.error({ err }, "sponsors:list-failed");
    return NextResponse.json(
      { error: "Failed to load sponsors" },
      { status: 500 },
    );
  }
}

// ── PUT — replace the entire sponsor list ───────────────────────

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW, route: "events/[eventId]/sponsors:PUT" });
    if (denied) return denied;

    // Defence in depth: denyReviewer already blocks the null-org roles, but
    // guard explicitly so the query never sees `organizationId: null` (and drop
    // the unsafe `!` below).
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn(
        { userId: session.user.id, role: session.user.role, eventId },
        "sponsors:update-no-org",
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `sponsors-update:${eventId}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "sponsors:update-rate-limited",
      );
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = sponsorsPutSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn(
        { errors: validated.error.flatten(), eventId },
        "sponsors:update-validation-failed",
      );
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // The list is now a TABLE, so replace-all becomes a diff with a refusal:
    // a sponsor the payload drops but a registration or promo code still
    // references stops the whole save (services/sponsor-service.ts §4).
    const result = await saveSponsors({
      eventId,
      organizationId,
      actorUserId: session.user.id,
      source: "rest",
      sponsors: validated.data.sponsors,
      mode: "replace",
    });

    if (!result.ok) {
      apiLogger.warn({
        msg: "sponsors:update-rejected",
        eventId,
        userId: session.user.id,
        code: result.code,
      });
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.inUse ? { inUse: result.inUse } : {}) },
        { status: HTTP_STATUS_FOR_SAVE_SPONSORS[result.code] },
      );
    }

    return NextResponse.json({ sponsors: result.sponsors });
  } catch (err) {
    apiLogger.error({ err }, "sponsors:update-failed");
    return NextResponse.json(
      { error: "Failed to update sponsors" },
      { status: 500 },
    );
  }
}
