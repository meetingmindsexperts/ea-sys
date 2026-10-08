/**
 * The one gate every `/api/blueprint/*` handler and the `/blueprint` page pass
 * through, in this order:
 *
 *   1. the module flag (BLUEPRINT_MODULE_ENABLED): off answers 404, so a
 *      module that is not available does not announce that it exists;
 *   2. a signed-in session (401);
 *   3. an organisation on the account (403): blueprints belong to one;
 *   4. the permission the handler names (`blueprints.view` / `.edit` / ...).
 *
 * Registered with both route gates (scripts/check-route-auth.mjs as a guard
 * module, scripts/check-route-permission.mjs as a primitive), because it calls
 * `auth()` and `requirePermission()` on the caller's behalf.
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { isBlueprintModuleEnabled } from "@/lib/module-flags";
import { requireOrgId } from "@/lib/require-org";
import { requirePermission } from "@/lib/permissions/require-permission";
import type { PermissionKey } from "@/lib/permissions/catalogue";

export type BlueprintGate =
  | { ok: true; session: Session; organizationId: string; userId: string }
  | { ok: false; response: NextResponse };

export async function blueprintGuard(permission: PermissionKey, route: string): Promise<BlueprintGate> {
  if (!isBlueprintModuleEnabled()) {
    apiLogger.warn({ msg: `${route}:blueprint-module-disabled` });
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: `${route}:unauthorized` });
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const org = requireOrgId(session, { route });
  if ("error" in org) return { ok: false, response: org.error };
  const gate = requirePermission(session, permission, { route });
  if (!gate.ok) return { ok: false, response: gate.response };
  return { ok: true, session, organizationId: org.orgId, userId: session.user.id };
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_ID: 400,
  NOT_AN_OBJECT: 400,
  TOO_DEEP: 400,
  ID_MISMATCH: 400,
  TOO_LARGE: 413,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  NOT_FOUND: 404,
};

/** A service refusal as HTTP. The service has already logged it with its code. */
export function blueprintErrorResponse(err: { code: string; message: string }): NextResponse {
  return NextResponse.json({ error: err.message, code: err.code }, { status: STATUS_BY_CODE[err.code] ?? 400 });
}
