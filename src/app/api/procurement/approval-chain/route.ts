/**
 * The spend request approval chain (Sep 28, 2026).
 *
 *   GET  anyone with procurement access: the chain and the people the
 *        dropdowns offer (read so the request form and pages can explain
 *        who approves).
 *   PUT  { levels: string[], standInUserId: string | null } SUPER ADMIN
 *        only, like every other grant: an empty `levels` turns the chain off.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse } from "@/lib/api-errors";
import { CHAIN_MAX_LEVELS } from "@/lib/approvals/approval-chain";
import { guardedRead, procurementGuard, readJson, rejected } from "@/procurement/lib/route-helpers";
import { getApprovalChain, saveApprovalChain } from "@/procurement/services/approval-chain-service";

const ROUTE = "procurement/approval-chain";

const putSchema = z.object({
  levels: z.array(z.string().min(1).max(64)).max(CHAIN_MAX_LEVELS),
  standInUserId: z.string().min(1).max(64).nullable(),
});

const STATUS: Record<string, number> = {
  TOO_FEW_LEVELS: 422,
  TOO_MANY_LEVELS: 422,
  DUPLICATE_PERSON: 422,
  UNKNOWN_PERSON: 422,
  SUPER_ADMIN_IN_CHAIN: 422,
  LEVEL_NOT_APPROVER: 422,
  LEVEL_HOLDS_SETTLE: 422,
  FINAL_NOT_UNLIMITED: 422,
  STAND_IN_IS_LEVEL: 422,
  UNKNOWN: 500,
};

export async function GET() {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => NextResponse.json(await getApprovalChain(g.orgId))));
}

export async function PUT(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "view", write: true });
  if (!g.ok) return g.response;
  if (g.user.role !== "SUPER_ADMIN") {
    apiLogger.warn({ msg: `${ROUTE}:forbidden`, userId: g.user.id, role: g.user.role ?? null });
    return NextResponse.json({ error: "Only a super admin sets the approval chain." }, { status: 403 });
  }
  const parsed = putSchema.safeParse(await readJson(req));
  if (!parsed.success) return zodErrorResponse(parsed, { route: ROUTE, userId: g.user.id });
  return runWithTenant(g.orgId, async () => {
    const result = await saveApprovalChain({ organizationId: g.orgId, actorUserId: g.user.id, config: { levels: parsed.data.levels, standInUserId: parsed.data.levels.length === 0 ? null : parsed.data.standInUserId } });
    if (!result.ok) return rejected(ROUTE, g.user.id, result, STATUS);
    return NextResponse.json(result.view);
  });
}
