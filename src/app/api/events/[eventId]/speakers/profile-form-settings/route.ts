/**
 * What this event asks its speakers for on their form link (Nov 19, 2026):
 * photo, bio, passport copy, cover letter, presentation. The event's default;
 * one speaker's own list is `speakers/[speakerId]/profile-form-items`.
 * Stored in `Event.settings.speakerProfile.items`, the way reimbursement's
 * claim items are. Rules: src/lib/speaker-profile/constants.ts.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { updateEventSettings } from "@/lib/event-settings";
import { profileItemsInputSchema, readEventProfileItems } from "@/lib/speaker-profile/constants";

type RouteParams = { params: Promise<{ eventId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "speakers.documents.write", { route: "events/[eventId]/speakers/profile-form-settings:GET", eventId });
    if (!gate.ok) return gate.response;

    const event = await findGatedEvent(gate, { select: { id: true, organizationId: true, settings: true } });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "speaker-profile-settings:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    // Nothing here reads the database (the event came through findGatedEvent);
    // the wrap keeps this swept domain's every-handler invariant honest.
    return await runWithTenant(event.organizationId, async () => NextResponse.json({ items: readEventProfileItems(event.settings) }));
  } catch (err) {
    apiLogger.error({ err }, "speaker-profile-settings:get-failed");
    return NextResponse.json({ error: "Failed to load the speaker form settings" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  const route = "events/[eventId]/speakers/profile-form-settings:PUT";
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "speakers.documents.write", { route, eventId });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({ key: `speaker-profile-settings:${session.user.id}`, limit: 60, windowMs: 3600_000 });
    if (!rl.allowed) return rateLimited(rl, { route, eventId, userId: session.user.id, limit: 60, windowSeconds: 3600 });

    const parsed = profileItemsInputSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed, { route, eventId, userId: session.user.id });

    const event = await findGatedEvent(gate, { select: { id: true, organizationId: true, settings: true } });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "speaker-profile-settings:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const before = readEventProfileItems(event.settings);
    const after = parsed.data.items;
    const ip = getClientIp(req);
    return await runWithTenant(event.organizationId, async () => {
      // Atomic merge under the row lock: only the `speakerProfile` sub-key
      // changes, and only its `items` field inside it.
      await updateEventSettings(eventId, (cur) => ({
        ...cur,
        speakerProfile: { ...((cur.speakerProfile as Record<string, unknown> | undefined) ?? {}), items: after },
      }));

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "SPEAKER_FORM_SETTINGS_SET",
            entityType: "Event",
            entityId: eventId,
            changes: { source: "rest", before: { items: before }, after: { items: after }, ip },
            ipAddress: ip,
          },
        })
        .catch((err) => apiLogger.error({ err, eventId }, "speaker-profile-settings:audit-failed"));

      apiLogger.info({ msg: "speaker-profile-settings:saved", eventId, userId: session.user.id, items: after });
      return NextResponse.json({ items: after });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-profile-settings:put-failed");
    return NextResponse.json({ error: "Failed to save the speaker form settings" }, { status: 500 });
  }
}
