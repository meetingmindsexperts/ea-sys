/**
 * Per-speaker reimbursement types: which claim items THIS speaker may claim.
 *
 *   GET  → { claimItems: ClaimItemKey[] | null, eventClaimItems, effective }
 *          claimItems null = inherits the event default (`eventClaimItems`);
 *          `effective` is what the form will actually offer.
 *   PATCH { claimItems: ClaimItemKey[] | null } → a list overrides the event
 *          default for this speaker; null goes back to inheriting it.
 *
 * Lives on Speaker (like the honorarium) so it is settable before any
 * reimbursement link exists. Sibling of the honorarium route with the same
 * boundary: `denyReviewer(session)` with NO allow-list, event through
 * buildEventAccessWhere, the write bound to { id, eventId }.
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
import { Prisma } from "@prisma/client";
import {
  readEventClaimItems,
  readSpeakerClaimItems,
  speakerClaimItemsInputSchema,
} from "@/lib/reimbursement/constants";

type RouteParams = { params: Promise<{ eventId: string; speakerId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, speakerId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/speakers/[speakerId]/reimbursement-types:GET" });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-reimbursement-types:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const speaker = await db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: { id: true, reimbursementClaimItems: true },
      });
      if (!speaker) {
        apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-reimbursement-types:speaker-not-found");
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      const eventClaimItems = readEventClaimItems(event.settings);
      const claimItems = readSpeakerClaimItems(speaker.reimbursementClaimItems);
      return NextResponse.json({ claimItems, eventClaimItems, effective: claimItems ?? eventClaimItems });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-reimbursement-types:get-failed");
    return NextResponse.json({ error: "Failed to load the reimbursement types" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const route = "events/[eventId]/speakers/[speakerId]/reimbursement-types:PATCH";
  try {
    const [session, { eventId, speakerId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/speakers/[speakerId]/reimbursement-types:PATCH" });
    if (denied) return denied;

    const rl = checkRateLimit({ key: `speaker-reimbursement-types:${session.user.id}`, limit: 60, windowMs: 3600_000 });
    if (!rl.allowed) {
      return rateLimited(rl, { route, eventId, speakerId, userId: session.user.id, limit: 60, windowSeconds: 3600 });
    }

    const parsed = speakerClaimItemsInputSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route, eventId, speakerId, userId: session.user.id });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-reimbursement-types:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const ip = getClientIp(req);
    return await runWithTenant(event.organizationId, async () => {
      const before = await db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: { id: true, reimbursementClaimItems: true },
      });
      if (!before) {
        apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-reimbursement-types:speaker-not-found");
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }

      const next = parsed.data.claimItems;
      // Bound to { id, eventId } on the write itself (defence #1).
      const { count } = await db.speaker.updateMany({
        where: { id: speakerId, eventId },
        data: { reimbursementClaimItems: next === null ? Prisma.JsonNull : next },
      });
      if (count === 0) {
        apiLogger.warn({ eventId, speakerId, userId: session.user.id }, "speaker-reimbursement-types:write-missed");
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }

      const previous = readSpeakerClaimItems(before.reimbursementClaimItems);
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "REIMBURSEMENT_TYPES_SET",
            entityType: "Speaker",
            entityId: speakerId,
            changes: { source: "rest", before: previous, after: next, ip },
            ipAddress: ip,
          },
        })
        .catch((err) => apiLogger.error({ err, eventId, speakerId }, "speaker-reimbursement-types:audit-failed"));

      apiLogger.info({ eventId, speakerId, userId: session.user.id, before: previous, after: next }, "speaker-reimbursement-types:set");
      const eventClaimItems = readEventClaimItems(event.settings);
      return NextResponse.json({ claimItems: next, eventClaimItems, effective: next ?? eventClaimItems });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-reimbursement-types:patch-failed");
    return NextResponse.json({ error: "Failed to save the reimbursement types" }, { status: 500 });
  }
}
