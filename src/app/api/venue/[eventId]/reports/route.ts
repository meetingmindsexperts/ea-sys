/**
 * POST /api/venue/:eventId/reports: raise a safety report (stored, then
 * emailed to the safety inbox). GET: every report, for the event team.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { venueGuard } from "@/lib/venue/route-guard";
import { venueDisplayName } from "@/lib/venue/display-name";
import { createReport, listReports } from "@/services/venue-service";

type Params = { params: Promise<{ eventId: string }> };
const bodySchema = z.record(z.string(), z.unknown());
const LIMIT = { limit: 20, windowMs: 60 * 60_000 };

export async function POST(req: Request, { params }: Params) {
  const ROUTE = "venue/reports:POST";
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `venue-report:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: gate.userId, limit: LIMIT.limit, windowSeconds: 3600 });
      const parsed = bodySchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, eventId, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const res = await createReport({ organizationId: gate.organizationId, eventId, userId: gate.userId }, parsed.data, {
        eventName: gate.event.name,
        reporterName: venueDisplayName(gate.session),
      });
      if (!res.ok) return NextResponse.json({ error: res.message, code: res.code }, { status: res.code === "TOO_LARGE" ? 413 : 400 });
      return NextResponse.json({ ok: true }, { status: 201 });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to send the report" }, { status: 500 });
  }
}

export async function GET(_req: Request, { params }: Params) {
  const ROUTE = "venue/reports:GET";
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE, { team: true });
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => NextResponse.json({ reports: await listReports(gate.organizationId, eventId) }));
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}
