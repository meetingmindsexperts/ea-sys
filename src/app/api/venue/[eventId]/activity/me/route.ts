/**
 * GET /api/venue/:eventId/activity/me: the signed-in person's own activity summary.
 * PUT: replace it (the venue saves every ~30 s and on leaving). Identity is
 * the session's, never the body's (venue-data.ts).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { venueGuard } from "@/lib/venue/route-guard";
import { venueDisplayName } from "@/lib/venue/display-name";
import { getMyActivity, saveMyActivity } from "@/services/venue-service";

type Params = { params: Promise<{ eventId: string }> };
const bodySchema = z.record(z.string(), z.unknown());
/** Every ~30 s while walking, plus on leaving: 240 an hour leaves room for two tabs. */
const LIMIT = { limit: 240, windowMs: 60 * 60_000 };

export async function GET(_req: Request, { params }: Params) {
  const ROUTE = "venue/activity/me:GET";
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () =>
      NextResponse.json({ activity: await getMyActivity({ organizationId: gate.organizationId, eventId, userId: gate.userId }) }),
    );
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: Params) {
  const ROUTE = "venue/activity/me:PUT";
  try {
    const { eventId } = await params;
    const gate = await venueGuard({ id: eventId }, ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `venue-activity:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: gate.userId, limit: LIMIT.limit, windowSeconds: 3600 });
      const parsed = bodySchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, eventId, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const res = await saveMyActivity({ organizationId: gate.organizationId, eventId, userId: gate.userId }, parsed.data, venueDisplayName(gate.session));
      if (!res.ok) return NextResponse.json({ error: res.message, code: res.code }, { status: 413 });
      return NextResponse.json({ ok: true });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
