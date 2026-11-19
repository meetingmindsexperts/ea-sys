/**
 * What ONE speaker's form link asks for (Nov 19, 2026), when it differs from
 * the event's default: `Speaker.profileFormItems`. Null goes back to the
 * default. A saved list REPLACES the default, never intersects it: asking one
 * speaker for a passport on an event that asks nobody is the point.
 * Rules: src/lib/speaker-profile/constants.ts.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { findGatedEvent } from "@/lib/tenant/event-tenant";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { readEventProfileItems, readSpeakerProfileItems, speakerProfileItemsInputSchema } from "@/lib/speaker-profile/constants";

type RouteParams = { params: Promise<{ eventId: string; speakerId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, speakerId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "speakers.documents.write", { route: "events/[eventId]/speakers/[speakerId]/profile-form-items:GET", eventId });
    if (!gate.ok) return gate.response;

    const event = await findGatedEvent(gate, { select: { id: true, organizationId: true, settings: true } });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    return await runWithTenant(event.organizationId, async () => {
      const speaker = await db.speaker.findFirst({ where: { id: speakerId, eventId }, select: { profileFormItems: true } });
      if (!speaker) {
        apiLogger.warn({ msg: "speaker-profile-items:not-found", eventId, speakerId, userId: session.user.id });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      return NextResponse.json({ items: readSpeakerProfileItems(speaker.profileFormItems), eventItems: readEventProfileItems(event.settings) });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-profile-items:get-failed");
    return NextResponse.json({ error: "Failed to load what this speaker is asked for" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const route = "events/[eventId]/speakers/[speakerId]/profile-form-items:PATCH";
  try {
    const [session, { eventId, speakerId }, body] = await Promise.all([auth(), params, req.json().catch(() => null)]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const gate = requirePermission(session, "speakers.documents.write", { route, eventId });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({ key: `speaker-profile-items:${session.user.id}`, limit: 300, windowMs: 3600_000 });
    if (!rl.allowed) return rateLimited(rl, { route, eventId, userId: session.user.id, limit: 300, windowSeconds: 3600 });

    const parsed = speakerProfileItemsInputSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed, { route, eventId, userId: session.user.id });

    const event = await findGatedEvent(gate, { select: { id: true, organizationId: true, settings: true } });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const ip = getClientIp(req);
    return await runWithTenant(event.organizationId, async () => {
      const speaker = await db.speaker.findFirst({ where: { id: speakerId, eventId }, select: { id: true, profileFormItems: true } });
      if (!speaker) {
        apiLogger.warn({ msg: "speaker-profile-items:not-found", eventId, speakerId, userId: session.user.id });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      const before = readSpeakerProfileItems(speaker.profileFormItems);
      const after = parsed.data.items;
      await db.speaker.update({
        where: { id: speakerId },
        // Prisma writes a JSON column's SQL NULL as DbNull, not null.
        data: { profileFormItems: after === null ? Prisma.DbNull : after },
      });

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "UPDATE",
            entityType: "Speaker",
            entityId: speakerId,
            changes: { source: "rest", profileFormItems: { before, after }, ip },
            ipAddress: ip,
          },
        })
        .catch((err) => apiLogger.error({ err, speakerId }, "speaker-profile-items:audit-failed"));

      apiLogger.info({ msg: "speaker-profile-items:saved", eventId, speakerId, userId: session.user.id, items: after });
      return NextResponse.json({ items: after, eventItems: readEventProfileItems(event.settings) });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-profile-items:patch-failed");
    return NextResponse.json({ error: "Failed to save what this speaker is asked for" }, { status: 500 });
  }
}
