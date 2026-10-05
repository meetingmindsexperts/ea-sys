/**
 * The route layer shared by the three custom-role endpoints: who may call them,
 * and how a service refusal becomes an HTTP status.
 *
 * ONE module because three routes need both, and a hand-copied status map is
 * how two endpoints end up disagreeing about whether a stale edit is a 409 or a
 * 400. The map is an exhaustive Record over the service's error union, so a new
 * code fails the BUILD rather than silently defaulting to 500.
 */

import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { apiLogger } from "@/lib/logger";
import { isCustomRolesEnabled, isProcurementModuleEnabled } from "@/lib/module-flags";
import { can } from "./can";
import { principalFromSession } from "./require-permission";
import type { PermissionSetErrorCode, PermissionSetFailure } from "./permission-set-service";

export const HTTP_STATUS_FOR_PERMISSION_SET_ERROR: Record<PermissionSetErrorCode, number> = {
  NAME_REQUIRED: 400,
  NO_PERMISSIONS: 400,
  UNKNOWN_PERMISSION: 400,
  DUPLICATE_NAME: 409,
  NOT_FOUND: 404,
  ARCHIVED: 409,
  STALE_WRITE: 409,
  // 422: the request was well formed and the role exists; the COMBINATION is
  // what is refused, which is a different thing for a client to act on.
  SEPARATION_CONFLICT: 422,
  SCOPE_REQUIRED: 400,
  SCOPE_NOT_ALLOWED: 400,
  // 409: the row exists and the request was well formed; what it names is not a thing that can be done to it.
  SYSTEM_ROLE: 409,
  // 403: the request is valid; the person saving it may not give this away.
  BEYOND_YOUR_ACCESS: 403,
  ADMIN_TRIO: 403,
  OWN_ROLE: 403,
  UNKNOWN: 500,
};

export function permissionSetErrorResponse(failure: PermissionSetFailure): NextResponse {
  const status = HTTP_STATUS_FOR_PERMISSION_SET_ERROR[failure.code];
  // Every refusal is logged, business rejections at warn and faults at error.
  apiLogger[status >= 500 ? "error" : "warn"]({
    msg: "permissions:route-refused",
    code: failure.code,
    status,
    ...(failure.meta ?? {}),
  });
  return NextResponse.json(
    { error: failure.message, code: failure.code, ...(failure.meta ? { meta: failure.meta } : {}) },
    { status },
  );
}

/**
 * SUPER ADMIN ONLY, and the restriction is the mechanism rather than caution.
 * A custom role can carry approval authority over money, so an admin who has
 * deliberately been kept out of approving must not be able to mint a role that
 * grants it and tag themselves with it. Same reasoning as `hrAccess` and the
 * four procurement grants beside it.
 *
 * 404 while the module is off, matching `denyNonProcurement`: a deployment
 * without Budget & Procurement has no roles to manage, and saying "forbidden"
 * would tell a caller the surface exists.
 */
export function denyNonRoleAdmin(session: Session | null, route: string): NextResponse | null {
  // Custom roles exist for Budgets, and for everything once switched on.
  if (!isProcurementModuleEnabled() && !isCustomRolesEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!session?.user) {
    apiLogger.warn({ msg: "permissions:unauthenticated", route });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.organizationId) {
    apiLogger.warn({ msg: "permissions:no-org", route, userId: session.user.id });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // `roles.manage`, which only SUPER_ADMIN holds (custom roles Phase 2).
  if (!can(principalFromSession(session), "roles.manage")) {
    apiLogger.warn({ msg: "permissions:not-super-admin", route, role: session.user.role, userId: session.user.id });
    return NextResponse.json(
      { error: "Only a super admin can manage custom roles.", code: "SUPER_ADMIN_ONLY" },
      { status: 403 },
    );
  }
  return null;
}
