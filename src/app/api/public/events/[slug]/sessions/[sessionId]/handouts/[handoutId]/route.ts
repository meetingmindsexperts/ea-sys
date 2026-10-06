import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { readStoredFile } from "@/lib/storage";
import { runWithTenant } from "@/lib/tenant-context";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import { readHandouts } from "@/lib/webinar/handouts";
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
      const handout = readHandouts(event.webinar).find((h) => h.id === handoutId);
      const eventPrefix = `${UPLOAD_PREFIX.webinarHandouts}${event.id}/`;
      if (!handout || !handout.storedPath.startsWith(eventPrefix)) {
        apiLogger.warn({ eventId: event.id, handoutId, found: !!handout }, "webinar-handouts:download-not-found");
        return NextResponse.json({ error: "Handout not found" }, { status: 404 });
      }
      const bytes = await readStoredFile(handout.storedPath, eventPrefix);
      apiLogger.info({ eventId: event.id, handoutId, registrationId: asker.kind === "attendee" ? asker.registrationId : null }, "webinar-handouts:downloaded");
      // PDFs open in the browser; Office files download.
      const disposition = handout.contentType === "application/pdf" ? "inline" : "attachment";
      return new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": handout.contentType,
          "Content-Disposition": `${disposition}; filename="${handout.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(handout.name)}`,
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-handouts:download-failed");
    return NextResponse.json({ error: "Failed to download the handout" }, { status: 500 });
  }
}
