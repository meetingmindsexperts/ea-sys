/**
 * GET /api/blueprint/blueprints/:id: one blueprint, server-owned fields merged in.
 * PUT /api/blueprint/blueprints/:id: save the page's whole object (it saves on
 * a 1 s debounce). The server keeps status, reference and history itself and
 * ignores them in the body (docs/EVENT_BLUEPRINT_PLAN.md §4.4).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { blueprintErrorResponse, blueprintGuard } from "@/lib/blueprint/route-guard";
import { getBlueprint, saveBlueprint } from "@/services/blueprint-service";

type Params = { params: Promise<{ id: string }> };

/** The shape only; the service checks size, depth and the id (blueprint-payload.ts). */
const bodySchema = z.record(z.string(), z.unknown());

/** The page saves at most once a second while someone types; 120 a minute leaves room for two tabs. */
const SAVE_LIMIT = { limit: 120, windowMs: 60_000 };

export async function GET(_req: Request, { params }: Params) {
  const ROUTE = "blueprint/blueprints/[id]:GET";
  try {
    const [gate, { id }] = await Promise.all([blueprintGuard("blueprints.view", ROUTE), params]);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const result = await getBlueprint(gate.organizationId, id);
      if (!result.ok) return blueprintErrorResponse(result);
      return NextResponse.json(result.blueprint);
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load the blueprint" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: Params) {
  const ROUTE = "blueprint/blueprints/[id]:PUT";
  try {
    const [gate, { id }] = await Promise.all([blueprintGuard("blueprints.edit", ROUTE), params]);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `blueprint-save:${gate.userId}`, ...SAVE_LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: gate.userId, limit: SAVE_LIMIT.limit, windowSeconds: 60 });

      const body = await req.json().catch(() => null);
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, id, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "NOT_AN_OBJECT" }, { status: 400 });
      }
      const result = await saveBlueprint({ organizationId: gate.organizationId, userId: gate.userId }, id, parsed.data);
      if (!result.ok) return blueprintErrorResponse(result);
      return NextResponse.json({ ok: true, updated: result.updated });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to save the blueprint" }, { status: 500 });
  }
}
