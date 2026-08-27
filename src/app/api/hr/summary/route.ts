/**
 * GET /api/hr/summary — the org-wide leave summary.
 *
 * This is the workbook's "Leave Summary" sheet as an API, and it is what the
 * one-time import reconciles against. Two queries in total, not two per
 * employee.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { denyNonHr } from "@/hr/lib/hr-roles";
import { getOrgLeaveSummary } from "@/hr/services/leave-balance-service";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/summary:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/summary" });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/summary" });
  if ("error" in org) return org.error;

  const sp = req.nextUrl.searchParams;
  const yearParam = sp.get("year");
  const leaveYear = yearParam ? Number(yearParam) : undefined;
  if (yearParam && (!Number.isInteger(leaveYear) || leaveYear! < 2000 || leaveYear! > 2100)) {
    apiLogger.warn({ msg: "hr/summary:invalid-year", year: yearParam, userId: session.user.id });
    return NextResponse.json({ error: "Invalid year", code: "INVALID_YEAR" }, { status: 400 });
  }

  return runWithTenant(org.orgId, async () => {
    try {
      const rows = await getOrgLeaveSummary({
        organizationId: org.orgId,
        leaveYear,
        includeExited: sp.get("includeExited") === "true",
      });
      return NextResponse.json({ summary: rows });
    } catch (err) {
      apiLogger.error({ msg: "hr/summary:failed", err, userId: session.user.id });
      return NextResponse.json({ error: "Could not build the summary." }, { status: 500 });
    }
  });
}
