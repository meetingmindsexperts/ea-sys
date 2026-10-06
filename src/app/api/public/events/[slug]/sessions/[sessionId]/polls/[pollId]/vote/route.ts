import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { livePollsEnabled, readPollOptions, validChoices } from "@/lib/webinar/live-polls";
import { forgetTally } from "@/lib/webinar/live-polls-server";
import { loadQuestionContext, resolveAsker } from "@/lib/webinar/viewer-question-access";

type RouteParams = { params: Promise<{ slug: string; sessionId: string; pollId: string }> };

const voteSchema = z.object({ choices: z.array(z.string().min(1).max(64)).min(1).max(6) });

/**
 * Answer a live poll on the webinar's custom-stream page (Oct 6, 2026;
 * docs/WEBINAR_INTERACTION_PLAN.md §5). A signed-in registrant only (staff
 * testing the page cannot vote), one answer per registration and final, only
 * while the poll is open, only this webinar's room session, and only while the
 * organiser has live polls switched on.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId, pollId }, body] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    if (!authSession?.user) {
      apiLogger.warn({ slug, sessionId, pollId }, "live-poll-vote:unauthenticated");
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    const { allowed, retryAfterSeconds } = checkRateLimit({ key: `live-poll-vote:${authSession.user.id}`, limit: 60, windowMs: 3600_000 });
    if (!allowed) {
      apiLogger.warn({ userId: authSession.user.id, pollId }, "live-poll-vote:rate-limited");
      return NextResponse.json({ error: "Too many answers this hour.", retryAfterSeconds }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
    }
    const parsed = voteSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), pollId }, "live-poll-vote:validation-failed");
      return NextResponse.json({ error: "Choose an answer" }, { status: 400 });
    }

    const event = await loadQuestionContext(req, slug, sessionId);
    if (!event) {
      apiLogger.warn({ slug, sessionId, pollId }, "live-poll-vote:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!livePollsEnabled(event.webinar)) {
      apiLogger.warn({ eventId: event.id, pollId }, "live-poll-vote:polls-off");
      return NextResponse.json({ error: "Polls are switched off for this webinar.", code: "POLLS_OFF" }, { status: 403 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const asker = await resolveAsker(authSession.user.id, event.id, authSession.user, event.organizationId);
      if (asker?.kind !== "attendee") {
        apiLogger.warn({ userId: authSession.user.id, eventId: event.id, kind: asker?.kind ?? "none" }, "live-poll-vote:not-a-registrant");
        return NextResponse.json({ error: "Only registered attendees can answer.", code: "NOT_REGISTERED" }, { status: 403 });
      }
      const poll = await db.livePoll.findFirst({
        where: { id: pollId, eventId: event.id, sessionId },
        select: { id: true, status: true, options: true, allowMultiple: true },
      });
      if (!poll) {
        apiLogger.warn({ eventId: event.id, pollId }, "live-poll-vote:poll-not-found");
        return NextResponse.json({ error: "Poll not found" }, { status: 404 });
      }
      if (poll.status !== "OPEN") {
        apiLogger.warn({ eventId: event.id, pollId, status: poll.status }, "live-poll-vote:poll-not-open");
        return NextResponse.json({ error: "This poll has closed.", code: "POLL_CLOSED" }, { status: 409 });
      }
      if (!validChoices(parsed.data.choices, readPollOptions(poll.options), poll.allowMultiple)) {
        apiLogger.warn({ eventId: event.id, pollId }, "live-poll-vote:invalid-choices");
        return NextResponse.json({ error: "That answer is not one of the options." }, { status: 400 });
      }
      try {
        await db.livePollVote.create({
          data: {
            pollId,
            registrationId: asker.registrationId,
            eventId: event.id,
            organizationId: event.organizationId,
            choices: parsed.data.choices,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          apiLogger.warn({ eventId: event.id, pollId }, "live-poll-vote:already-answered");
          return NextResponse.json({ error: "You have already answered this poll.", code: "ALREADY_ANSWERED" }, { status: 409 });
        }
        throw err;
      }
      forgetTally(pollId);
      apiLogger.info({ eventId: event.id, pollId }, "live-poll-vote:recorded");
      return NextResponse.json({ ok: true, choices: parsed.data.choices }, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "live-poll-vote:failed");
    return NextResponse.json({ error: "Failed to record your answer" }, { status: 500 });
  }
}
