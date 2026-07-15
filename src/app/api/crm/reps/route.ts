import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { UserRole } from "@prisma/client";
import { requireCrmRead } from "@/crm/lib/crm-route";

/**
 * GET /api/crm/reps — the org's deal-OWNING staff as {id, firstName, lastName, role}.
 *
 * A "rep" is anyone who can own a deal: the sales team (CRM_USER) and the admin
 * tier (ADMIN / SUPER_ADMIN / ORGANIZER) — the same set as `canOwnDeals`. The owner
 * filter uses this instead of the org-wide /api/organization/users so a CRM_USER
 * (confined to the CRM) can populate the picker without reaching a non-CRM endpoint,
 * and so the list is exactly the deal-owning roles rather than every team member.
 */
const REP_ROLES: UserRole[] = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "CRM_USER"];

export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  try {
    const reps = await db.user.findMany({
      where: {
        organizationId: ctx.organizationId,
        role: { in: REP_ROLES },
      },
      select: { id: true, firstName: true, lastName: true, role: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 500,
    });
    return NextResponse.json({ reps });
  } catch (err) {
    apiLogger.error({
      msg: "crm/reps:failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load reps" }, { status: 500 });
  }
}
