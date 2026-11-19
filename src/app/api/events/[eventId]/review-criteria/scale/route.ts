import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { requirePermission } from "@/lib/permissions/require-permission";
import { db } from "@/lib/db";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { updateEventSettings } from "@/lib/event-settings";
import { isReviewScoreScale, readReviewScoreScale, REVIEW_SCORE_SCALES } from "@/lib/abstract-score";

/**
 * The event's criterion scoring scale (Nov 19, 2026): what a reviewer scores
 * each criterion out of, 5, 10 or 100 (abstract-score.ts has the rule).
 *
 *   GET  → { scale, locked, reviewCount }
 *   PUT  { scale } → the same, after the change
 *
 * It is FIXED once the first review is submitted on the event (owner): stored
 * criterion scores are raw numbers on the scale they were given on, and
 * nothing converts them, so a later change would silently re-mean every score
 * already in. PUT answers 409 SCALE_LOCKED then. This route is the only writer
 * of `Event.settings.reviewScoreScale` (ROUTE_OWNED_SETTINGS_KEYS): the event
 * edit drops the key, because it cannot make that check.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const putSchema = z.object({ scale: z.number().int() }).strict();

/** Reviews submitted on the event's abstracts: any one fixes the scale. */
function countReviews(eventId: string): Promise<number> {
  return db.abstractReviewSubmission.count({ where: { abstract: { eventId } } });
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/review-criteria/scale:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "abstracts.read", { route: "events/[eventId]/review-criteria/scale:GET", eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    return await runWithTenant(orgGuard.orgId, async () => {
      const [event, reviewCount] = await Promise.all([
        findGatedEvent(gate, { select: { id: true, settings: true } }),
        countReviews(eventId),
      ]);
      if (!event) {
        apiLogger.warn({ msg: "review-score-scale:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      return NextResponse.json({ scale: readReviewScoreScale(event.settings), locked: reviewCount > 0, reviewCount });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "review-score-scale:GET failed" });
    return NextResponse.json({ error: "Failed to load the scoring scale" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json().catch(() => null)]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/review-criteria/scale:PUT" });
    if ("error" in orgGuard) return orgGuard.error;
    // The key that manages the criteria the scale applies to.
    const gate = requirePermission(session, "abstracts.criteria.manage", { route: "events/[eventId]/review-criteria/scale:PUT", eventId });
    if (!gate.ok) return gate.response;

    const parsed = putSchema.safeParse(body);
    if (!parsed.success || !isReviewScoreScale(parsed.data.scale)) {
      apiLogger.warn({ msg: "review-score-scale:invalid-input", eventId, userId: session.user.id, errors: parsed.success ? { scale: "not one of the scales" } : parsed.error.flatten() });
      return NextResponse.json({ error: `Choose a scale of ${REVIEW_SCORE_SCALES.join(", ")}.`, code: "INVALID_SCALE" }, { status: 400 });
    }
    const scale = parsed.data.scale;

    return await runWithTenant(orgGuard.orgId, async () => {
      const [event, reviewCount] = await Promise.all([
        findGatedEvent(gate, { select: { id: true, settings: true } }),
        countReviews(eventId),
      ]);
      if (!event) {
        apiLogger.warn({ msg: "review-score-scale:event-not-found", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const current = readReviewScoreScale(event.settings);
      // Saving the scale it already has changes nothing, locked or not.
      if (scale === current) return NextResponse.json({ scale: current, locked: reviewCount > 0, reviewCount });

      if (reviewCount > 0) {
        apiLogger.warn({ msg: "review-score-scale:locked", eventId, userId: session.user.id, current, requested: scale, reviewCount });
        return NextResponse.json(
          {
            error: `Reviewers have already submitted ${reviewCount} review${reviewCount === 1 ? "" : "s"} on the 0 to ${current} scale, so it can no longer be changed.`,
            code: "SCALE_LOCKED",
            scale: current,
            reviewCount,
          },
          { status: 409 },
        );
      }

      await updateEventSettings(eventId, { reviewScoreScale: scale }, { organizationId: orgGuard.orgId });
      apiLogger.info({ msg: "review-score-scale:changed", eventId, userId: session.user.id, from: current, to: scale });
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "UPDATE",
            entityType: "Event",
            entityId: eventId,
            changes: { before: { reviewScoreScale: current }, after: { reviewScoreScale: scale }, source: "rest", ip: getClientIp(req) },
          },
        })
        .catch((err) => apiLogger.error({ err, msg: "review-score-scale:audit-log-failed", eventId }));
      return NextResponse.json({ scale, locked: false, reviewCount: 0 });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "review-score-scale:PUT failed" });
    return NextResponse.json({ error: "Failed to save the scoring scale" }, { status: 500 });
  }
}
