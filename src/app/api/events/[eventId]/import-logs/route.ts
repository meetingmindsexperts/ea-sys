import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/permissions/require-permission";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "analytics.read", { route: "events/[eventId]/import-logs:GET", eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    // Verify event access
    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const logs = await db.importLog.findMany({
      where: { eventId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return NextResponse.json(logs);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching import logs" });
    return NextResponse.json(
      { error: "Failed to fetch import logs" },
      { status: 500 }
    );
  }
}
