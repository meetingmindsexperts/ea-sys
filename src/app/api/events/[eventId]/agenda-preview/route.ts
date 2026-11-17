import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { runWithTenant } from "@/lib/tenant-context";
import { agendaPayload, isAgendaPublished, loadAgendaEvent } from "@/lib/agenda-data";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/**
 * The public agenda as attendees will see it, for staff, before it is
 * published (Nov 17, 2026). Opened by the Preview button on the event's Agenda
 * page, which loads `/e/{slug}/agenda?preview={eventId}`.
 *
 * Staff only: an unpublished agenda can name speakers who have not confirmed,
 * which is why the survey builder's open preview is not the model here. The
 * key is the one that opens the programme in the dashboard (`sessions.read`);
 * reviewers, submitters and registrants are not let in (no `linkedRoles`).
 * Any event status: the point is to look before going live.
 *
 * Never cached anywhere: the public route's answer is `public, max-age=60`,
 * and an unpublished programme must not sit in a shared cache. Not indexed.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      apiLogger.info({ msg: "agenda-preview:signed-out", eventId });
      return privateJson({ error: "Sign in to preview the agenda", code: "SIGN_IN_REQUIRED" }, 401);
    }

    const gate = requirePermission(session, "sessions.read", {
      route: "events/[eventId]/agenda-preview:GET",
      eventId,
      onMissing: "hide",
    });
    if (!gate.ok) return gate.response;

    const scope = await findGatedEvent(gate, { select: { id: true, organizationId: true } });
    if (!scope) {
      apiLogger.warn({ msg: "agenda-preview:event-not-found", eventId, userId: session.user.id });
      return privateJson({ error: "Event not found", code: "EVENT_NOT_FOUND" }, 404);
    }

    return await runWithTenant(scope.organizationId, async () => {
      const event = await loadAgendaEvent(scope.id);
      if (!event) {
        apiLogger.warn({ msg: "agenda-preview:event-vanished", eventId, userId: session.user.id });
        return privateJson({ error: "Event not found", code: "EVENT_NOT_FOUND" }, 404);
      }

      const published = isAgendaPublished(event.settings);
      apiLogger.info({ msg: "agenda-preview:served", eventId, userId: session.user.id, published });
      return privateJson({ ...agendaPayload(event), preview: true, published }, 200);
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "agenda-preview:failed" });
    return privateJson({ error: "Failed to load the agenda preview" }, 500);
  }
}

function privateJson(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}
