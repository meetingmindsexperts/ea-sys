/** GET the organisation's purchase orders (need "view"); optional ?status=, ?budgetId=, ?supplierId=, ?eventCode=. */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { guardedRead, procurementGuard } from "@/procurement/lib/route-helpers";
import { invalidCommitmentStatusFilter, listCommitments } from "@/procurement/services/commitment-service";

const ROUTE = "procurement/commitments";

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const budgetId = req.nextUrl.searchParams.get("budgetId") ?? undefined;
  const supplierId = req.nextUrl.searchParams.get("supplierId") ?? undefined;
  const eventCode = req.nextUrl.searchParams.get("eventCode")?.slice(0, 50) || undefined;
  if (invalidCommitmentStatusFilter(status)) {
    apiLogger.warn({ msg: `${ROUTE}:invalid-filter`, status, userId: g.user.id });
    return NextResponse.json({ error: "Unknown status filter", code: "INVALID_FILTER" }, { status: 400 });
  }
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const commitments = await listCommitments(g.orgId, { status, budgetId, supplierId, eventCode });
    return NextResponse.json({ commitments });
  }));
}
