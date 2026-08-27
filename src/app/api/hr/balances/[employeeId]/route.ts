/** GET /api/hr/balances/[employeeId] — one person's leave balances. */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { denyNonHr } from "@/hr/lib/hr-roles";
import { getLeaveBalance } from "@/hr/services/leave-balance-service";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> },
) {
  const [session, { employeeId }] = await Promise.all([auth(), params]);
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/balance:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/balance" });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/balance" });
  if ("error" in org) return org.error;

  const yearParam = req.nextUrl.searchParams.get("year");
  const leaveYear = yearParam ? Number(yearParam) : undefined;
  if (yearParam && (!Number.isInteger(leaveYear) || leaveYear! < 2000 || leaveYear! > 2100)) {
    apiLogger.warn({ msg: "hr/balance:invalid-year", year: yearParam, userId: session.user.id });
    return NextResponse.json({ error: "Invalid year", code: "INVALID_YEAR" }, { status: 400 });
  }

  return runWithTenant(org.orgId, async () => {
    try {
      const result = await getLeaveBalance({
        organizationId: org.orgId,
        employeeId,
        leaveYear,
      });
      if (!result) {
        apiLogger.warn({ msg: "hr/balance:employee-not-found", employeeId, userId: session.user.id });
        return NextResponse.json({ error: "Employee not found." }, { status: 404 });
      }
      return NextResponse.json(result);
    } catch (err) {
      apiLogger.error({ msg: "hr/balance:failed", err, employeeId });
      return NextResponse.json({ error: "Could not compute balances." }, { status: 500 });
    }
  });
}
