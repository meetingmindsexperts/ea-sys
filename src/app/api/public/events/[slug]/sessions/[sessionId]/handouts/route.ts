import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { readHandouts, toPublicHandout } from "@/lib/webinar/handouts";
import { loadQuestionContext, resolveAsker } from "@/lib/webinar/viewer-question-access";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

/**
 * The webinar's handouts for the attendee page (Oct 6, 2026;
 * docs/WEBINAR_INTERACTION_PLAN.md §4): names, types and sizes, never the
 * storage path. Same gate as the Q&A box: signed in, and a non-cancelled
 * registrant of the webinar or org staff testing the page.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId }] = await Promise.all([auth(), params]);
    if (!authSession?.user) {
      apiLogger.warn({ slug, sessionId }, "webinar-handouts:list-unauthenticated");
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    const event = await loadQuestionContext(req, slug, sessionId, { includeCompleted: true });
    if (!event) {
      apiLogger.warn({ slug, sessionId }, "webinar-handouts:list-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return await runWithTenant(event.organizationId, async () => {
      const asker = await resolveAsker(authSession.user.id, event.id, authSession.user, event.organizationId);
      if (!asker) {
        apiLogger.warn({ userId: authSession.user.id, eventId: event.id }, "webinar-handouts:list-not-registered");
        return NextResponse.json({ error: "Not registered", code: "NOT_REGISTERED" }, { status: 403 });
      }
      const res = NextResponse.json({ handouts: readHandouts(event.webinar).map(toPublicHandout) });
      res.headers.set("Cache-Control", "private, no-store");
      return res;
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-handouts:list-failed");
    return NextResponse.json({ error: "Failed to load the handouts" }, { status: 500 });
  }
}
