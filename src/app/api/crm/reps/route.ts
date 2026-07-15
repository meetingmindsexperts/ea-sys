import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { UserRole } from "@prisma/client";
import { requireCrmRead } from "@/crm/lib/crm-route";

/**
 * GET /api/crm/reps — the org's sales reps as {id, firstName, lastName, role}.
 *
 * A "rep" is the sales team (CRM_USER) + the admin tier (ADMIN / SUPER_ADMIN).
 * ORGANIZER is deliberately EXCLUDED (owner decision, July 15): organizers run
 * events, not the sponsorship pipeline, so they'd only clutter the owner/rep picker
 * — even though `canOwnDeals` still permits an organizer to own a deal if one is
 * assigned by other means. The owner filter uses this instead of the org-wide
 * /api/organization/users so a CRM_USER (confined to the CRM) can populate the
 * picker without reaching a non-CRM endpoint.
 */
const REP_ROLES: UserRole[] = ["SUPER_ADMIN", "ADMIN", "CRM_USER"];

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
