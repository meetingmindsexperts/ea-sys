/**
 * GET /api/venue/:eventId/config: the venue's settings (language filter,
 * recordings per screen) from Event.settings.venue.
 * PUT { filter }: the event team saves the language filter.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { venueGuard } from "@/lib/venue/route-guard";
import { readVenueConfig, saveFilter } from "@/services/venue-service";

type Params = { params: Promise<{ eventId: string }> };
const bodySchema = z.object({ filter: z.record(z.string(), z.unknown()) });

export async function GET(_req: Request, { params }: Params) {
  const ROUTE = "venue/config:GET";
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => NextResponse.json(readVenueConfig(gate.event.settings)));
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: Params) {
  const ROUTE = "venue/config:PUT";
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE, { team: true });
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const parsed = bodySchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, eventId, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const filter = await saveFilter(gate.organizationId, eventId, parsed.data.filter);
      apiLogger.info({ msg: `${ROUTE}:saved`, userId: gate.userId, eventId });
      return NextResponse.json({ filter });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
