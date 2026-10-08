/** GET /api/blueprint/templates: the organisation's saved templates, newest first. */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { blueprintGuard } from "@/lib/blueprint/route-guard";
import { listTemplates } from "@/services/blueprint-service";

const ROUTE = "blueprint/templates:GET";

export async function GET() {
  try {
    const gate = await blueprintGuard("blueprints.view", ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      return NextResponse.json(await listTemplates(gate.organizationId));
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load templates" }, { status: 500 });
  }
}
