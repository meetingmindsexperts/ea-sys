import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { MAX_PRESENTATION_TYPE_LABEL, presentationTypeKeySchema } from "@/lib/abstract-presentation-types";
import { changePresentationType, listPresentationTypesWithUse, type ChangePresentationTypeResult } from "@/services/presentation-type-service";

/**
 * The organisation's presentation types (Nov 24, 2026; step 3 of
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md). GET the list with what holds each
 * type; PUT ONE change: add, rename, retire, restore or delete. Both need
 * `abstracts.types.manage` (admins and organisers, or a custom role given it).
 * Which types an EVENT offers is the event's own setting, saved with the
 * event; the forms read the list through `GET /api/events/{id}/presentation-types`.
 */

const label = z.string().max(MAX_PRESENTATION_TYPE_LABEL + 20);
const putSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), label }).strict(),
  z.object({ action: z.literal("rename"), key: presentationTypeKeySchema, label }).strict(),
  z.object({ action: z.literal("retire"), key: presentationTypeKeySchema }).strict(),
  z.object({ action: z.literal("restore"), key: presentationTypeKeySchema }).strict(),
  z.object({ action: z.literal("delete"), key: presentationTypeKeySchema }).strict(),
]);

const HTTP_STATUS: Record<Exclude<ChangePresentationTypeResult, { ok: true }>["code"], number> = {
  LABEL_INVALID: 400,
  LABEL_TAKEN: 409,
  TOO_MANY: 409,
  NOT_FOUND: 404,
  BUILT_IN_NOT_DELETABLE: 409,
  IN_USE: 409,
  LAST_LIVE_TYPE: 409,
  NO_CHANGE: 409,
  ORGANIZATION_NOT_FOUND: 404,
  UNKNOWN: 500,
};

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "abstracts.types.manage", { route: "organization/presentation-types:GET" });
    if (!gate.ok) return gate.response;
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn({ msg: "presentation-types:list-no-org", userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // The session's lane: the counts read abstracts and reviews.
    return await runWithTenantLane(organizationId, { route: "organization/presentation-types:GET", userId: session.user.id }, async () => {
      const types = await listPresentationTypesWithUse(organizationId);
      if (!types) {
        apiLogger.warn({ msg: "presentation-types:organization-not-found", organizationId });
        return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
      }
      const response = NextResponse.json({ types });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    });
  } catch (err) {
    apiLogger.error({ err, msg: "presentation-types:list-failed" });
    return NextResponse.json({ error: "Failed to load the presentation types" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "abstracts.types.manage", { route: "organization/presentation-types:PUT" });
    if (!gate.ok) return gate.response;
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn({ msg: "presentation-types:update-no-org", userId: session.user.id, role: session.user.role });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({ key: `presentation-types-update:${organizationId}`, limit: 120, windowMs: 3600_000 });
    if (!allowed) {
      apiLogger.warn({ msg: "presentation-types:update-rate-limited", organizationId, userId: session.user.id });
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds, limit: 120, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "presentation-types:update-validation-failed", organizationId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const userId = session.user.id;
    return await runWithTenantLane(organizationId, { route: "organization/presentation-types:PUT", userId }, async () => {
      const result = await changePresentationType({ organizationId, actorUserId: userId, change: parsed.data, source: "rest" });
      if (!result.ok) {
        apiLogger.warn({ msg: "presentation-types:update-rejected", organizationId, userId, code: result.code, action: parsed.data.action });
        return NextResponse.json({ error: result.message, code: result.code }, { status: HTTP_STATUS[result.code] });
      }
      return NextResponse.json({ key: result.key, types: result.types });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "presentation-types:update-failed" });
    return NextResponse.json({ error: "Failed to save the presentation types" }, { status: 500 });
  }
}
