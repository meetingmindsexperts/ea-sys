import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { canEverywhere } from "@/lib/permissions/can";
import { checkRateLimit } from "@/lib/security";
import { getSponsorTiers } from "@/lib/sponsors";
import { MAX_CUSTOM_SPONSOR_TIERS, MAX_SPONSOR_TIER_LABEL } from "@/lib/sponsor-tiers";
import { saveSponsorTiers, type SaveSponsorTiersErrorCode } from "@/services/sponsor-tier-service";

/**
 * The organisation's sponsor tiers (Oct 15, 2026): GET the built-ins plus its
 * own, PUT the custom list as a whole. Organisation-wide, so any event's
 * sponsors page offers them. Read with sponsors.read. Changing them needs
 * sponsors.manage on EVERY event (owner, Oct 15, 2026): a tier shows on every
 * event, so a role that manages sponsors only on some events (assigned ones,
 * webinars) may use the tiers but not rename or remove them.
 */

const putSchema = z.object({
  tiers: z
    .array(
      z.object({
        key: z.string().min(1).max(60).optional().nullable(),
        label: z.string().max(MAX_SPONSOR_TIER_LABEL + 20),
      }),
    )
    .max(MAX_CUSTOM_SPONSOR_TIERS),
});

/** Exhaustive over the service's error union, so a new code fails the build. */
const HTTP_STATUS: Record<SaveSponsorTiersErrorCode, number> = {
  ORGANIZATION_NOT_FOUND: 404,
  TOO_MANY: 400,
  INVALID_LABEL: 400,
  DUPLICATE_LABEL: 409,
  UNKNOWN_TIER: 409,
  TIER_IN_USE: 409,
  UNKNOWN: 500,
};

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "sponsors.read", { route: "organization/sponsor-tiers:GET" });
    if (!gate.ok) return gate.response;
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn({ userId: session.user.id, role: session.user.role }, "sponsor-tiers:list-no-org");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ tiers: await getSponsorTiers(organizationId) });
  } catch (err) {
    apiLogger.error({ err }, "sponsor-tiers:list-failed");
    return NextResponse.json({ error: "Failed to load sponsor tiers" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "sponsors.manage", { route: "organization/sponsor-tiers:PUT" });
    if (!gate.ok) return gate.response;
    if (!canEverywhere(gate.principal, "sponsors.manage")) {
      apiLogger.warn({ msg: "sponsor-tiers:update-not-org-wide", userId: session.user.id, role: session.user.role });
      return NextResponse.json(
        { error: "Changing sponsor tiers needs sponsor management on every event.", code: "NOT_ORG_WIDE" },
        { status: 403 },
      );
    }
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn({ userId: session.user.id, role: session.user.role }, "sponsor-tiers:update-no-org");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `sponsor-tiers-update:${organizationId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ organizationId, userId: session.user.id }, "sponsor-tiers:update-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), organizationId }, "sponsor-tiers:update-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const result = await saveSponsorTiers({ organizationId, actorUserId: session.user.id, tiers: parsed.data.tiers });
    if (!result.ok) {
      apiLogger.warn({ msg: "sponsor-tiers:update-rejected", organizationId, userId: session.user.id, code: result.code });
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.inUse ? { inUse: result.inUse } : {}) },
        { status: HTTP_STATUS[result.code] },
      );
    }
    return NextResponse.json({ tiers: result.tiers });
  } catch (err) {
    apiLogger.error({ err }, "sponsor-tiers:update-failed");
    return NextResponse.json({ error: "Failed to save sponsor tiers" }, { status: 500 });
  }
}
