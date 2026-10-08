/** GET /api/venue/:eventId/activity: everyone's activity in the venue, for the event team. */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { venueGuard } from "@/lib/venue/route-guard";
import { listActivity } from "@/services/venue-service";

type Params = { params: Promise<{ eventId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const ROUTE = "venue/activity:GET";
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE, { team: true });
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => NextResponse.json({ activity: await listActivity(gate.organizationId, eventId) }));
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}
