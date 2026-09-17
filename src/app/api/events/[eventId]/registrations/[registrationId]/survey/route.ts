/**
 * Reset one registration's survey (Sep 17, 2026, organizer request).
 *
 *   DELETE /api/events/[eventId]/registrations/[registrationId]/survey
 *
 * Deletes the person's survey answers and clears what the submission set, so
 * they can answer again from a fresh Survey Invitation:
 *   - the SurveyResponse row;
 *   - Registration.surveyCompletedAt, the CME certificate trigger;
 *   - the certificate auto-issue bookkeeping (checked / attempts / next
 *     attempt / error), so answering again is checked again. This is also the
 *     way to cover someone who answered before auto-issue was switched on;
 *   - the "survey-completed" tag, unless another registration of the same
 *     attendee still carries a completed survey (Attendee rows can be shared).
 *
 * Owner decisions: admins and organizers may reset (denyReviewer with no
 * allow-list, so members, desk staff and the webinar role cannot);
 * certificates already issued are KEPT (the dialog says so first; revoking a
 * credential is its own deliberate action); the answers are not copied
 * anywhere, the audit row records who, when and how many answers.
 *
 * Both the registration sheet and the survey responses page call this route.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { SURVEY_COMPLETED_TAG } from "@/lib/survey/schema";

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

const ROUTE = "events/[eventId]/registrations/[registrationId]/survey:DELETE";
const RESET_LIMIT = 60;

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, registrationId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: ROUTE });
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `survey-reset:${session.user.id}`,
      limit: RESET_LIMIT,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, { route: ROUTE, userId: session.user.id, limit: RESET_LIMIT, windowSeconds: 3600 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "survey-reset:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Registration, SurveyResponse and Attendee are swept tables: work in the
    // event's own org (an org-null SUPER_ADMIN legitimately reaches this).
    return await runWithTenant(event.organizationId, async () => {
      const registration = await db.registration.findFirst({
        where: { id: registrationId, eventId },
        select: {
          id: true,
          attendeeId: true,
          surveyCompletedAt: true,
          surveyResponse: { select: { id: true, answers: true } },
          issuedCertificates: { where: { revokedAt: null }, select: { serial: true } },
        },
      });
      if (!registration) {
        apiLogger.warn({ msg: "survey-reset:registration-not-found", eventId, registrationId });
        return NextResponse.json({ error: "Registration not found" }, { status: 404 });
      }
      if (!registration.surveyCompletedAt && !registration.surveyResponse) {
        apiLogger.warn({ msg: "survey-reset:nothing-to-reset", eventId, registrationId });
        return NextResponse.json(
          { error: "This person has not completed the survey.", code: "NOTHING_TO_RESET" },
          { status: 409 },
        );
      }

      const answerCount =
        registration.surveyResponse?.answers && typeof registration.surveyResponse.answers === "object"
          ? Object.keys(registration.surveyResponse.answers as Record<string, unknown>).length
          : 0;

      const { tagRemoved } = await tenantTransaction(async (tx) => {
        await tx.surveyResponse.deleteMany({ where: { registrationId } });
        await tx.registration.updateMany({
          where: { id: registrationId, eventId },
          data: {
            surveyCompletedAt: null,
            certAutoIssueCheckedAt: null,
            certAutoIssueAttempts: 0,
            certAutoIssueNextAttemptAt: null,
            certAutoIssueError: null,
          },
        });

        // The tag lives on the Attendee, which another registration may share.
        const stillCompletedElsewhere = await tx.registration.count({
          where: {
            attendeeId: registration.attendeeId,
            id: { not: registrationId },
            surveyCompletedAt: { not: null },
          },
        });
        if (stillCompletedElsewhere > 0) return { tagRemoved: false };

        const attendee = await tx.attendee.findUnique({
          where: { id: registration.attendeeId },
          select: { tags: true },
        });
        // Any capitalization: saving the registration normalizes tags, which
        // turns the submitted "survey-completed" into "Survey-completed".
        const isCompletedTag = (t: string) => t.toLowerCase() === SURVEY_COMPLETED_TAG;
        if (!attendee?.tags.some(isCompletedTag)) return { tagRemoved: false };
        await tx.attendee.update({
          where: { id: registration.attendeeId },
          data: { tags: attendee.tags.filter((t) => !isCompletedTag(t)) },
        });
        return { tagRemoved: true };
      });

      const keptCertificates = registration.issuedCertificates.map((c) => c.serial);

      // Fire-and-forget: the reset already committed.
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "SURVEY_RESET",
            entityType: "Registration",
            entityId: registrationId,
            changes: {
              surveyCompletedAt: registration.surveyCompletedAt?.toISOString() ?? null,
              answerCount,
              tagRemoved,
              keptCertificates,
              ip: getClientIp(req),
            },
          },
        })
        .catch((err) => apiLogger.warn({ err, msg: "survey-reset:audit-log-failed", eventId, registrationId }));

      apiLogger.info({
        msg: "survey-reset:done",
        eventId,
        registrationId,
        userId: session.user.id,
        answerCount,
        tagRemoved,
        keptCertificates: keptCertificates.length,
      });

      return NextResponse.json({ success: true, keptCertificates });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "survey-reset:unhandled" });
    return NextResponse.json({ error: "Failed to reset the survey" }, { status: 500 });
  }
}
