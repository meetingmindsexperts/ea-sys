import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { denyNonRoleAdmin } from "@/lib/permissions/route-guard";
import { readHolderWarnings } from "@/lib/permissions/permission-set-service";

/**
 * The role editor's warnings that need the database (plan §8.3), for the
 * draft being edited: "assigned events" grants on a role nobody assigned
 * holds, and keys that need a person grant some holders lack. POST because
 * it judges the unsaved draft; it writes nothing.
 */
interface RouteParams {
  params: Promise<{ permissionSetId: string }>;
}

const schema = z.object({
  permissions: z
    .array(
      z.union([
        z.string().max(100),
        z.object({ permission: z.string().max(100), scope: z.enum(["ALL", "ASSIGNED", "WEBINAR"]).nullable().optional() }),
      ]),
    )
    .max(200),
});

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { permissionSetId }, body] = await Promise.all([auth(), params, req.json()]);
    const denied = denyNonRoleAdmin(session, "permission-sets/warnings:POST");
    if (denied) return denied;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "permissions:warnings-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const orgId = session!.user.organizationId!;
    const warnings = await runWithTenant(orgId, () => readHolderWarnings(orgId, permissionSetId, parsed.data.permissions));
    return NextResponse.json({ warnings });
  } catch (error) {
    apiLogger.error({ err: error, msg: "permissions:warnings-failed" });
    return NextResponse.json({ error: "Failed to check the role" }, { status: 500 });
  }
}
