import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { canWrite } from "@/lib/can-write";
import { QUESTION_MAX_LENGTH, publicAskerName } from "@/lib/webinar/questions";
import { readWebinarSettings } from "@/lib/webinar";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

const askSchema = z.object({
  question: z.string().trim().min(3, "Please type a question").max(QUESTION_MAX_LENGTH),
});

type Asker =
  | { kind: "staff"; name: string }
  | { kind: "attendee"; name: string; registrationId: string };

/**
 * Questions from custom-stream viewers (Oct 1, 2026). A viewer of the HLS
 * stream is not in Zoom, so Zoom's Q&A cannot reach them; this is the box on
 * the session page, read by producers in the Webinar Console.
 *
 * Same gate as the presence heartbeat and zoom-join: signed in, and either a
 * non-cancelled registrant of the event or org staff testing the page. The
 * asker's name comes from the registration, never from the request body.
 */
async function resolveAsker(
  userId: string,
  eventId: string,
  user: { role?: string | null; organizationId?: string | null; firstName?: string | null; lastName?: string | null },
  eventOrgId: string,
): Promise<Asker | null> {
  if (canWrite(user.role) && user.organizationId === eventOrgId) {
    return { kind: "staff", name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "Staff" };
  }
  const registration = await db.registration.findFirst({
    where: { eventId, userId, status: { not: "CANCELLED" } },
    select: { id: true, attendee: { select: { firstName: true, lastName: true } } },
  });
  if (!registration?.attendee) return null;
  return {
    kind: "attendee",
    name: `${registration.attendee.firstName} ${registration.attendee.lastName}`.trim() || "Attendee",
    registrationId: registration.id,
  };
}

/**
 * The event, if this session takes viewer questions: only the anchor session
 * of a WEBINAR event, the one session whose questions the producers' console
 * lists (code review, Oct 1, 2026: questions accepted elsewhere reached
 * nobody).
 */
async function loadContext(req: Request, slug: string, sessionId: string) {
  const event = await db.event.findFirst({
    where: await publicEventWhere(req, slug, { statuses: ["DRAFT", "PUBLISHED", "LIVE"] }),
    select: { id: true, organizationId: true, eventType: true, settings: true },
  });
  if (!event) return null;
  if (event.eventType !== "WEBINAR" || readWebinarSettings(event.settings)?.sessionId !== sessionId) {
    apiLogger.warn({ slug, sessionId, eventType: event.eventType }, "webinar-question:not-the-webinar-room");
    return null;
  }
  return { id: event.id, organizationId: event.organizationId };
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => ({})),
    ]);
    if (!authSession?.user) {
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-question:${authSession.user.id}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: authSession.user.id, sessionId }, "webinar-question:rate-limited");
      return NextResponse.json(
        { error: "You have asked a lot of questions this hour. Please wait a little.", retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = askSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten() }, "webinar-question:validation-failed");
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid question" },
        { status: 400 },
      );
    }

    const event = await loadContext(req, slug, sessionId);
    if (!event) {
      apiLogger.warn({ slug, sessionId }, "webinar-question:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const asker = await resolveAsker(authSession.user.id, event.id, authSession.user, event.organizationId);
      if (!asker) {
        apiLogger.warn({ userId: authSession.user.id, eventId: event.id }, "webinar-question:not-registered");
        return NextResponse.json({ error: "Not registered", code: "NOT_REGISTERED" }, { status: 403 });
      }
      const sessionRow = await db.eventSession.findFirst({
        where: { id: sessionId, eventId: event.id },
        select: { id: true },
      });
      if (!sessionRow) {
        apiLogger.warn({ sessionId, eventId: event.id }, "webinar-question:session-not-found");
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const created = await db.webinarViewerQuestion.create({
        data: {
          eventId: event.id,
          organizationId: event.organizationId,
          sessionId,
          registrationId: asker.kind === "attendee" ? asker.registrationId : null,
          askerName: asker.name,
          question: parsed.data.question,
        },
        select: { id: true, question: true, status: true, createdAt: true },
      });
      apiLogger.info({ eventId: event.id, sessionId, questionId: created.id }, "webinar-question:asked");
      return NextResponse.json({ question: created }, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-question:ask-failed");
    return NextResponse.json({ error: "Failed to send your question" }, { status: 500 });
  }
}

/**
 * The Q&A tab: the signed-in viewer's own questions, and the questions the
 * organizer has shown to everyone (`isPublic`, never dismissed ones), with
 * the asker reduced to first name and initial. Newest first.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId }] = await Promise.all([auth(), params]);
    if (!authSession?.user) {
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    const event = await loadContext(req, slug, sessionId);
    if (!event) {
      apiLogger.warn({ slug, sessionId }, "webinar-question:list-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return await runWithTenant(event.organizationId, async () => {
      const asker = await resolveAsker(authSession.user.id, event.id, authSession.user, event.organizationId);
      if (!asker) {
        apiLogger.warn({ userId: authSession.user.id, eventId: event.id }, "webinar-question:list-not-registered");
        return NextResponse.json({ error: "Not registered", code: "NOT_REGISTERED" }, { status: 403 });
      }
      const [mine, shown] = await Promise.all([
        asker.kind === "staff"
          ? Promise.resolve([])
          : db.webinarViewerQuestion.findMany({
              where: { sessionId, eventId: event.id, registrationId: asker.registrationId },
              orderBy: { createdAt: "desc" },
              take: 50,
              select: { id: true, question: true, status: true, isPublic: true, createdAt: true },
            }),
        db.webinarViewerQuestion.findMany({
          where: { sessionId, eventId: event.id, isPublic: true, status: { not: "DISMISSED" } },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: { id: true, question: true, status: true, askerName: true, createdAt: true },
        }),
      ]);
      const published = shown.map(({ askerName, ...q }) => ({ ...q, askerName: publicAskerName(askerName) }));
      return NextResponse.json({ questions: mine, published });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-question:list-failed");
    return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
  }
}
