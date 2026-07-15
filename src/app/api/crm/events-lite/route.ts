import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";

/**
 * GET /api/crm/events-lite — the org's events as {id, name} ONLY.
 *
 * The CRM's deal/report event pickers use this instead of the full /api/events,
 * so a CRM_USER (confined to the CRM, zero event-API access) can still TAG a deal
 * to an event without being handed any event data beyond its name. Staff use it
 * too — it decouples the CRM from the heavy events API.
 *
 * Only PUBLISHED events are returned — i.e. events that have gone live to the world
 * (PUBLISHED / LIVE / COMPLETED), not DRAFT or CANCELLED. You sell sponsorships
 * against announced events; a draft isn't real yet and a cancelled one is off.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  try {
    const events = await db.event.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { notIn: ["DRAFT", "CANCELLED"] },
      },
      select: { id: true, name: true },
      orderBy: { startDate: "desc" },
      take: 1000,
    });
    return NextResponse.json({ events });
  } catch (err) {
    apiLogger.error({
      msg: "crm/events-lite:failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load events" }, { status: 500 });
  }
}
