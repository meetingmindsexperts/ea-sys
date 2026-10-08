/** PUT /api/blueprint/templates/:id: save a template (`{ id, name, type, state }`). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { blueprintErrorResponse, blueprintGuard } from "@/lib/blueprint/route-guard";
import { saveTemplate } from "@/services/blueprint-service";

type Params = { params: Promise<{ id: string }> };

const ROUTE = "blueprint/templates/[id]:PUT";
const bodySchema = z.record(z.string(), z.unknown());
const LIMIT = { limit: 30, windowMs: 60 * 60_000 };

export async function PUT(req: Request, { params }: Params) {
  try {
    const [gate, { id }] = await Promise.all([blueprintGuard("blueprints.edit", ROUTE), params]);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `blueprint-template:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: gate.userId, limit: LIMIT.limit, windowSeconds: 3600 });

      const body = await req.json().catch(() => null);
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, id, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "NOT_AN_OBJECT" }, { status: 400 });
      }
      const result = await saveTemplate({ organizationId: gate.organizationId, userId: gate.userId }, id, parsed.data);
      if (!result.ok) return blueprintErrorResponse(result);
      return NextResponse.json({ ok: true });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to save the template" }, { status: 500 });
  }
}
