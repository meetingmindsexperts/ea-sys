import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions/require-permission";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { eventPresentationTypes } from "@/lib/abstract-presentation-types";
import { loadPresentationTypes } from "@/lib/abstract-presentation-types-server";

/**
 * The presentation types a page shows for this event (Nov 24, 2026;
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md): the organisation's whole list,
 * retired types included so a stored type still shows its name, each marked
 * `offered` when this event's forms offer it. Pages never keep a list or a
 * name of their own (`abstract-presentation-types.ts`).
 *
 * Read by staff and by the people linked to the event's abstracts (authors,
 * reviewers), who are org-independent: like the themes list, the event is
 * found first and its organisation's list is read. Names are not sensitive.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gate = requirePermission(session, "abstracts.read", {
      route: "events/[eventId]/presentation-types:GET",
      eventId,
      onMissing: "hide",
      linkedRoles: "linked",
    });
    if (!gate.ok) return gate.response;

    const event = await findGatedEvent(gate, { select: { id: true, organizationId: true, settings: true } });
    if (!event) {
      apiLogger.warn({ msg: "presentation-types:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const types = await runWithTenant(event.organizationId, () => loadPresentationTypes(event.organizationId));
    const response = NextResponse.json({ types: eventPresentationTypes(event.settings, types) });
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (err) {
    apiLogger.error({ err, msg: "presentation-types:GET failed" });
    return NextResponse.json({ error: "Failed to load presentation types" }, { status: 500 });
  }
}
