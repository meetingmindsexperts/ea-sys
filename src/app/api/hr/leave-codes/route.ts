/** GET /api/hr/leave-codes — the org's leave-code catalogue, seeded on first use. */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { denyNonHr } from "@/hr/lib/hr-roles";
import { ensureLeaveCodes } from "@/hr/services/hr-seed-service";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/leave-codes:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/leave-codes" });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/leave-codes" });
  if ("error" in org) return org.error;

  return runWithTenant(org.orgId, async () => {
    try {
      await ensureLeaveCodes(org.orgId);
      const codes = await db.leaveCode.findMany({
        where: { organizationId: org.orgId, active: true },
        select: {
          id: true, code: true, label: true, lawReference: true,
          paid: true, dayWeight: true, countsAs: true, sortOrder: true,
        },
        orderBy: { sortOrder: "asc" },
      });
      return NextResponse.json({
        leaveCodes: codes.map((c) => ({ ...c, dayWeight: Number(c.dayWeight) })),
      });
    } catch (err) {
      apiLogger.error({ msg: "hr/leave-codes:failed", err, userId: session.user.id });
      return NextResponse.json({ error: "Could not load leave codes." }, { status: 500 });
    }
  });
}
