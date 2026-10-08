/**
 * POST /api/blueprint/blueprints/:id/approve { which: "plan" | "preview" }:
 * an approver (`blueprints.approve`) signs off. The plan's approval checks the
 * blueprint is complete on the server and creates the EA-SYS event; the
 * preview's makes it Live. Never the writer or a later editor (409).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { blueprintGuard } from "@/lib/blueprint/route-guard";
import { approveBlueprint } from "@/services/blueprint-workflow-service";
import { workflowErrorResponse } from "@/lib/blueprint/workflow-http";

type Params = { params: Promise<{ id: string }> };

const ROUTE = "blueprint/blueprints/[id]/approve:POST";
const LIMIT = { limit: 30, windowMs: 60 * 60_000 };
const bodySchema = z.object({ which: z.enum(["plan", "preview"]) });

export async function POST(req: Request, { params }: Params) {
  try {
    const [gate, { id }] = await Promise.all([blueprintGuard("blueprints.approve", ROUTE), params]);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `blueprint-approve:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: gate.userId, limit: LIMIT.limit, windowSeconds: 3600 });
      const body = await req.json().catch(() => null);
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, id, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const result = await approveBlueprint({ organizationId: gate.organizationId, userId: gate.userId }, id, parsed.data.which);
      if (!result.ok) return workflowErrorResponse(result);
      return NextResponse.json(result.blueprint);
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to approve the blueprint" }, { status: 500 });
  }
}
