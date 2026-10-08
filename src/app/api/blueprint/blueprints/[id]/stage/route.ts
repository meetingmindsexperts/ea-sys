/**
 * POST /api/blueprint/blueprints/:id/stage { to }: a build-team stage move
 * (`blueprints.manage`). Building and Live are refused here: only an
 * approval reaches them.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { blueprintGuard } from "@/lib/blueprint/route-guard";
import { moveBlueprintStage } from "@/services/blueprint-workflow-service";
import { workflowErrorResponse } from "@/lib/blueprint/workflow-http";

type Params = { params: Promise<{ id: string }> };

const ROUTE = "blueprint/blueprints/[id]/stage:POST";

/** The page sends its lowercase stage ids (`in_review`). */
const bodySchema = z.object({
  to: z.enum(["submitted", "in_review", "plan_ready", "building", "preview", "live"]),
});

export async function POST(req: Request, { params }: Params) {
  try {
    const [gate, { id }] = await Promise.all([blueprintGuard("blueprints.manage", ROUTE), params]);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const body = await req.json().catch(() => null);
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, id, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const to = parsed.data.to.toUpperCase() as "SUBMITTED" | "IN_REVIEW" | "PLAN_READY" | "BUILDING" | "PREVIEW" | "LIVE";
      const result = await moveBlueprintStage({ organizationId: gate.organizationId, userId: gate.userId }, id, to);
      if (!result.ok) return workflowErrorResponse(result);
      return NextResponse.json(result.blueprint);
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to move the blueprint" }, { status: 500 });
  }
}
