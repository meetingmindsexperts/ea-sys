/**
 * Speaker honorarium / speaker fee — organiser-set, read + write.
 *
 *   GET   → { honorarium: { amount, currency } | null }
 *   PATCH { amount, currency } → sets it. Amount 0 CLEARS it (both columns
 *          null): a currency without an amount is not a state readHonorarium
 *          can mean, so it is not one we store.
 *
 * The figure lives on Speaker (event-scoped already) so {{honorarium}} resolves
 * in every speaker email, weeks before a reimbursement link exists. On the
 * reimbursement form the line is LOCKED: the speaker sees this value and
 * cannot add or change it — the public POST writes it from the row, never
 * from the body. Owner decisions, Sep 3 2026.
 *
 * ACCESS: the reimbursement boundary — SUPER_ADMIN / ADMIN / ORGANIZER only.
 * `denyReviewer(session)` with NO allow-list is exactly that set (see
 * canManageReimbursements). Deliberately NOT folded into the speaker PUT:
 * that route admits WEBINARS on webinar events, and a payment figure follows
 * the stricter boundary. The event resolves through buildEventAccessWhere
 * and the speaker is bound to { id, eventId } on the write itself.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import {
  formatHonorarium,
  honorariumInputSchema,
  readHonorarium,
} from "@/lib/reimbursement/constants";

type RouteParams = { params: Promise<{ eventId: string; speakerId: string }> };

const HONORARIUM_SELECT = { id: true, honorariumAmount: true, honorariumCurrency: true } as const;

export async function GET(_req: Request, { params }: RouteParams) {
  const route = "events/[eventId]/speakers/[speakerId]/honorarium:GET";
  try {
    const [session, { eventId, speakerId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-honorarium:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const speaker = await db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: HONORARIUM_SELECT,
      });
      if (!speaker) {
        apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-honorarium:speaker-not-found");
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      return NextResponse.json({ honorarium: readHonorarium(speaker) });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-honorarium:get-failed");
    return NextResponse.json({ error: "Failed to load the honorarium" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const route = "events/[eventId]/speakers/[speakerId]/honorarium:PATCH";
  try {
    const [session, { eventId, speakerId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route });
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `speaker-honorarium:${session.user.id}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, { route, eventId, speakerId, userId: session.user.id, limit: 60, windowSeconds: 3600 });
    }

    const parsed = honorariumInputSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route, eventId, speakerId, userId: session.user.id });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-honorarium:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const ip = getClientIp(req);
    return await runWithTenant(event.organizationId, async () => {
      const before = await db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: HONORARIUM_SELECT,
      });
      if (!before) {
        apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-honorarium:speaker-not-found");
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }

      const amount = Math.round(parsed.data.amount * 100) / 100;
      const data =
        amount > 0
          ? { honorariumAmount: amount, honorariumCurrency: parsed.data.currency }
          : { honorariumAmount: null, honorariumCurrency: null };
      // Bound to { id, eventId } on the write itself, not only on the read
      // above (defence #1 — the tenancy rule for every by-id mutation).
      const { count } = await db.speaker.updateMany({ where: { id: speakerId, eventId }, data });
      if (count === 0) {
        apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-honorarium:write-missed");
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }

      const previous = readHonorarium(before);
      const next = readHonorarium(data);

      // A payment figure changed hands: before → after, who, from where.
      // Fire-and-forget with a logged catch (an audit blip must not fail a
      // committed write).
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "HONORARIUM_SET",
            entityType: "Speaker",
            entityId: speakerId,
            // Plain objects, not the Honorarium interface (Prisma's JSON input
            // type wants an index signature the interface does not carry).
            changes: {
              source: "rest",
              before: previous ? { amount: previous.amount, currency: previous.currency } : null,
              after: next ? { amount: next.amount, currency: next.currency } : null,
              ip,
            },
            ipAddress: ip,
          },
        })
        .catch((err) => apiLogger.error({ err, eventId, speakerId }, "speaker-honorarium:audit-failed"));

      apiLogger.info(
        {
          eventId,
          speakerId,
          userId: session.user.id,
          before: formatHonorarium(previous),
          after: formatHonorarium(next),
        },
        "speaker-honorarium:set",
      );
      return NextResponse.json({ honorarium: next });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-honorarium:patch-failed");
    return NextResponse.json({ error: "Failed to save the honorarium" }, { status: 500 });
  }
}
