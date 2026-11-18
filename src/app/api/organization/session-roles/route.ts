import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { MAX_SESSION_ROLE_LABEL, MAX_SESSION_ROLES } from "@/lib/session-roles";
import { runWithTenant } from "@/lib/tenant-context";
import { getSessionRoles, getSessionRolesWithCounts, saveSessionRoles, type SaveSessionRolesErrorCode } from "@/services/session-role-service";
import { can } from "@/lib/permissions/can";

/**
 * The organisation's session roles (Nov 18, 2026; docs/SESSION_ROLES_PLAN.md):
 * GET the list (built-ins included, in order), PUT it as a whole. Read with
 * sessions.read, since every agenda picker offers them. Changed with
 * org.settings (owner decision D5: organisation admins, in Settings), since a
 * role is offered on every event of the organisation.
 */

const putSchema = z.object({
  roles: z
    .array(
      z.object({
        key: z.string().min(1).max(60).optional().nullable(),
        label: z.string().max(MAX_SESSION_ROLE_LABEL + 20),
        duty: z.enum(["RUNS", "PRESENTS"]),
        hidden: z.boolean().optional(),
      }),
    )
    .max(MAX_SESSION_ROLES),
});

/** Exhaustive over the service's error union, so a new code fails the build. */
const HTTP_STATUS: Record<SaveSessionRolesErrorCode, number> = {
  ORGANIZATION_NOT_FOUND: 404,
  TOO_MANY: 400,
  INVALID_LABEL: 400,
  DUPLICATE_LABEL: 409,
  UNKNOWN_ROLE: 409,
  BUILT_IN_REQUIRED: 400,
  BUILT_IN_DUTY_FIXED: 400,
  ROLE_IN_USE: 409,
  UNKNOWN: 500,
};

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "sessions.read", { route: "organization/session-roles:GET" });
    if (!gate.ok) return gate.response;
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn({ userId: session.user.id, role: session.user.role }, "session-roles:list-no-org");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // The counts are organisation-wide, so only for those who edit the list
    // (Settings); a picker needs the names. Counts read SessionSpeaker,
    // which is policied: inside the lane.
    if (!can(gate.principal, "org.settings")) {
      return NextResponse.json({ roles: (await getSessionRoles(organizationId)).map((r) => ({ ...r, assignments: 0 })) });
    }
    const roles = await runWithTenant(organizationId, () => getSessionRolesWithCounts(organizationId));
    return NextResponse.json({ roles });
  } catch (err) {
    apiLogger.error({ err }, "session-roles:list-failed");
    return NextResponse.json({ error: "Failed to load session roles" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "org.settings", { route: "organization/session-roles:PUT" });
    if (!gate.ok) return gate.response;
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      apiLogger.warn({ userId: session.user.id, role: session.user.role }, "session-roles:update-no-org");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `session-roles-update:${organizationId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ organizationId, userId: session.user.id }, "session-roles:update-rate-limited");
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds, limit: 30, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), organizationId }, "session-roles:update-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    // The in-use count reads SessionSpeaker, which is policied: inside the lane.
    const result = await runWithTenant(organizationId, () =>
      saveSessionRoles({ organizationId, actorUserId: session.user.id, roles: parsed.data.roles }),
    );
    if (!result.ok) {
      apiLogger.warn({ msg: "session-roles:update-rejected", organizationId, userId: session.user.id, code: result.code });
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.inUse ? { inUse: result.inUse } : {}) },
        { status: HTTP_STATUS[result.code] },
      );
    }
    const roles = await runWithTenant(organizationId, () => getSessionRolesWithCounts(organizationId));
    return NextResponse.json({ roles });
  } catch (err) {
    apiLogger.error({ err }, "session-roles:update-failed");
    return NextResponse.json({ error: "Failed to save session roles" }, { status: 500 });
  }
}
