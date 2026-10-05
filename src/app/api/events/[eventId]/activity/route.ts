import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { requirePermission } from "@/lib/permissions/require-permission";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Activity feed is internal-only: `activity.read` (SUPER_ADMIN, ADMIN, ORGANIZER).
    const gate = requirePermission(session, "activity.read", { route: "events/[eventId]/activity:GET", eventId });
    if (!gate.ok) return gate.response;

    // Verify event access
    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, organizationId: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 50);

    // RESOURCE-org tenant lane (the event's org, resolved through the access
    // guard above) — inert on master, the RLS backstop on the platform.
    const logs = await runWithTenant(event.organizationId, () =>
      db.auditLog.findMany({
        where: { eventId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          changes: true,
          createdAt: true,
          user: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
      }),
    );

    return NextResponse.json(logs);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to fetch activity log" });
    return NextResponse.json(
      { error: "Failed to fetch activity" },
      { status: 500 }
    );
  }
}
