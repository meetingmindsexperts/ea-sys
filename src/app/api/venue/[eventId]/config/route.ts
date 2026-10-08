/**
 * GET /api/venue/:eventId/config: the venue's settings (language filter,
 * recordings per screen, AI attendees on or off) from Event.settings.venue;
 * the event team also gets today's AI replies against the daily cap.
 * PUT { filter?, ai? }: the event team saves the language filter, or switches
 * AI attendees on or off.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { venueGuard } from "@/lib/venue/route-guard";
import { readVenueConfig, saveFilter } from "@/services/venue-service";
import { readVenueAi, saveVenueAi, usageToday, venueDay } from "@/services/venue-ai-service";
import { resolveTimezone } from "@/lib/event-time";

type Params = { params: Promise<{ eventId: string }> };
const bodySchema = z
  .object({ filter: z.record(z.string(), z.unknown()).optional(), ai: z.object({ on: z.boolean() }).optional() })
  .refine((b) => b.filter !== undefined || b.ai !== undefined, { message: "Nothing to save" });

export async function GET(_req: Request, { params }: Params) {
  const ROUTE = "venue/config:GET";
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const ai = readVenueAi(gate.event.settings);
      const usage = gate.team ? await usageToday(gate.organizationId, eventId, venueDay(resolveTimezone(gate.event.timezone))) : null;
      return NextResponse.json({ ...readVenueConfig(gate.event.settings), ai: usage ? { ...ai, ...usage } : ai });
    });
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
      const { filter, ai } = parsed.data;
      const saved = {
        ...(filter && { filter: await saveFilter(gate.organizationId, eventId, filter) }),
        ...(ai && { ai: await saveVenueAi(gate.organizationId, eventId, ai.on) }),
      };
      apiLogger.info({ msg: `${ROUTE}:saved`, userId: gate.userId, eventId, filter: !!filter, ai: ai?.on });
      return NextResponse.json(saved);
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
