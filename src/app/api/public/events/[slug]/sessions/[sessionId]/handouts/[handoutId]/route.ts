import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { readHandouts } from "@/lib/webinar/handouts";
import { handoutDownloadResponse } from "@/lib/webinar/handout-download";
import { loadQuestionContext, resolveAsker } from "@/lib/webinar/viewer-question-access";

type RouteParams = { params: Promise<{ slug: string; sessionId: string; handoutId: string }> };

/**
 * Download one handout (Oct 6, 2026). Private by owner decision: the file is
 * streamed only to a signed-in registrant of this webinar (or org staff
 * testing the page), so a forwarded link opens for no one else. The handout
 * is looked up in THIS event's list, and its path must sit under this event's
 * private prefix before any read.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId, handoutId }] = await Promise.all([auth(), params]);
    if (!authSession?.user) {
      apiLogger.warn({ slug, sessionId, handoutId }, "webinar-handouts:download-unauthenticated");
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    // Per person: a whole class clicking "Slides" at once is fine, one viewer
    // looping the link is not (each download reads the file from storage).
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-handout-download:${authSession.user.id}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: authSession.user.id, sessionId, handoutId }, "webinar-handouts:download-rate-limited");
      return NextResponse.json(
        { error: "Too many downloads this hour. Please wait a little.", retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }
    const event = await loadQuestionContext(req, slug, sessionId, { includeCompleted: true });
    if (!event) {
      apiLogger.warn({ slug, sessionId, handoutId }, "webinar-handouts:download-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return await runWithTenant(event.organizationId, async () => {
      const asker = await resolveAsker(authSession.user.id, event.id, authSession.user, event.organizationId);
      if (!asker) {
        apiLogger.warn({ userId: authSession.user.id, eventId: event.id, handoutId }, "webinar-handouts:download-not-registered");
        return NextResponse.json({ error: "Not registered", code: "NOT_REGISTERED" }, { status: 403 });
      }
      return handoutDownloadResponse(event.id, readHandouts(event.webinar).find((h) => h.id === handoutId), {
        handoutId,
        registrationId: asker.kind === "attendee" ? asker.registrationId : null,
      });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-handouts:download-failed");
    return NextResponse.json({ error: "Failed to download the handout" }, { status: 500 });
  }
}
