/**
 * GET /api/blueprint/me: who the Blueprint page is talking to. `isEditor` is
 * the vendor's "build team" flag, which shows the stage control; here it is
 * `blueprints.manage`. The server enforces the stage moves regardless.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { blueprintGuard } from "@/lib/blueprint/route-guard";
import { can } from "@/lib/permissions/can";
import { principalFromSession } from "@/lib/permissions/require-permission";

const ROUTE = "blueprint/me:GET";

export async function GET() {
  try {
    const gate = await blueprintGuard("blueprints.view", ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const principal = principalFromSession(gate.session);
      return NextResponse.json({
        id: gate.userId,
        isEditor: can(principal, "blueprints.manage"),
        canWrite: can(principal, "blueprints.edit"),
      canApprove: can(principal, "blueprints.approve"),
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}
