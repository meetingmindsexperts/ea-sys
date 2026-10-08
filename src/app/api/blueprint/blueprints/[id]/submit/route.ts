/**
 * POST /api/blueprint/blueprints/:id/submit: send a blueprint to the build
 * team. The first time, Draft to Submitted with a reference; afterwards an
 * update with its change list. The server decides which, and emails the team.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { blueprintGuard } from "@/lib/blueprint/route-guard";
import { submitBlueprint } from "@/services/blueprint-workflow-service";
import { workflowErrorResponse } from "@/lib/blueprint/workflow-http";

type Params = { params: Promise<{ id: string }> };

const ROUTE = "blueprint/blueprints/[id]/submit:POST";
const LIMIT = { limit: 30, windowMs: 60 * 60_000 };

const bodySchema = z.object({
  readiness: z.number().int().min(0).max(100).default(0),
  open: z.array(z.string().max(200)).max(100).default([]),
  count: z.number().int().min(0).max(10_000).default(0),
  changes: z.array(z.string().max(400)).max(80).default([]),
});

export async function POST(req: Request, { params }: Params) {
  try {
    const [gate, { id }] = await Promise.all([blueprintGuard("blueprints.edit", ROUTE), params]);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `blueprint-submit:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: gate.userId, limit: LIMIT.limit, windowSeconds: 3600 });
      const body = await req.json().catch(() => undefined);
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, id, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const result = await submitBlueprint({ organizationId: gate.organizationId, userId: gate.userId }, id, parsed.data);
      if (!result.ok) return workflowErrorResponse(result);
      return NextResponse.json(result.blueprint);
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to submit the blueprint" }, { status: 500 });
  }
}
