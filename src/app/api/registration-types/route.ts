import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { runWithTenant } from "@/lib/tenant-context";
import { auth } from "@/lib/auth";
import { principalFromCaller, requirePermission } from "@/lib/permissions/require-permission";

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The registration-type names of the events this caller may read
    // (`tickets.read`, Phase 6 review, Oct 7, 2026; it had no key at all).
    // "hide": someone without the key gets an empty list, so the contact form's
    // dropdown still renders for a CRM user rather than erroring.
    const principal = principalFromCaller(await auth(), ctx);
    if (!principal) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(principal, "tickets.read", { route: "registration-types:GET", onMissing: "hide" });
    if (!gate.ok) return gate.response;

    // TicketType is policied, so the org filter alone is not enough: without a
    // tenant lane this returns zero rows under RLS and the registration-type
    // dropdown is silently empty everywhere it is used.
    const ticketTypes = await runWithTenant(ctx.organizationId, () =>
      db.ticketType.findMany({
        where: { event: { AND: [{ organizationId: ctx.organizationId }, gate.eventWhere] } },
        select: { name: true },
        distinct: ["name"],
        orderBy: { name: "asc" },
      }),
    );

    const names = ticketTypes.map((t) => t.name);

    const response = NextResponse.json(names);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=60");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching registration types" });
    return NextResponse.json({ error: "Failed to fetch registration types" }, { status: 500 });
  }
}
