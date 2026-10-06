import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { qaUpvoteEnabled } from "@/lib/webinar/questions";
import { loadQuestionContext, resolveAsker } from "@/lib/webinar/viewer-question-access";

type RouteParams = { params: Promise<{ slug: string; sessionId: string; questionId: string }> };

/**
 * Upvote a question on the webinar's custom-stream page (Oct 6, 2026;
 * docs/WEBINAR_INTERACTION_PLAN.md §3). A toggle: voting again removes the
 * vote. Only questions the moderators made public (and not dismissed) take
 * votes, only on this webinar's room session, only from a signed-in
 * registrant (one vote per registration; staff testing the page cannot vote),
 * and only while the producer leaves upvotes on.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId, questionId }] = await Promise.all([auth(), params]);
    if (!authSession?.user) {
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-question-vote:${authSession.user.id}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: authSession.user.id, sessionId }, "webinar-question-vote:rate-limited");
      return NextResponse.json(
        { error: "Too many votes this hour. Please wait a little.", retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const event = await loadQuestionContext(req, slug, sessionId);
    if (!event) {
      apiLogger.warn({ slug, sessionId }, "webinar-question-vote:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!qaUpvoteEnabled(event.webinar)) {
      apiLogger.warn({ eventId: event.id, questionId }, "webinar-question-vote:upvotes-off");
      return NextResponse.json({ error: "Upvotes are switched off for this webinar.", code: "UPVOTES_OFF" }, { status: 403 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const asker = await resolveAsker(authSession.user.id, event.id, authSession.user, event.organizationId);
      if (asker?.kind !== "attendee") {
        apiLogger.warn({ userId: authSession.user.id, eventId: event.id, kind: asker?.kind ?? "none" }, "webinar-question-vote:not-a-registrant");
        return NextResponse.json({ error: "Only registered attendees can vote.", code: "NOT_REGISTERED" }, { status: 403 });
      }
      // Bound to this event's room session and to a public, live question, so
      // a private, dismissed or foreign question id is refused.
      const question = await db.webinarViewerQuestion.findFirst({
        where: { id: questionId, eventId: event.id, sessionId, isPublic: true, status: { not: "DISMISSED" } },
        select: { id: true },
      });
      if (!question) {
        apiLogger.warn({ eventId: event.id, questionId }, "webinar-question-vote:question-not-votable");
        return NextResponse.json({ error: "Question not found" }, { status: 404 });
      }

      const removed = await db.webinarQuestionVote.deleteMany({
        where: { questionId, registrationId: asker.registrationId },
      });
      let voted = false;
      if (removed.count === 0) {
        try {
          await db.webinarQuestionVote.create({
            data: { questionId, registrationId: asker.registrationId, eventId: event.id, organizationId: event.organizationId },
          });
          voted = true;
        } catch (err) {
          // A double click raced us to the same vote: it is recorded.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
          apiLogger.info({ eventId: event.id, questionId }, "webinar-question-vote:duplicate-ignored");
          voted = true;
        }
      }
      const voteCount = await db.webinarQuestionVote.count({ where: { questionId } });
      apiLogger.info({ eventId: event.id, questionId, voted }, "webinar-question-vote:toggled");
      return NextResponse.json({ voted, voteCount });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-question-vote:failed");
    return NextResponse.json({ error: "Failed to record your vote" }, { status: 500 });
  }
}
