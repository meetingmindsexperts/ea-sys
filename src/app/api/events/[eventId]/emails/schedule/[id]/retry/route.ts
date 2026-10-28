import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { bulkEmailTypePermission } from "@/lib/permissions/field-permissions";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { WEBINAR_SEQUENCE_PHASES, isSequenceRowForOtherDate } from "@/lib/webinar-email-sequence";

interface RouteParams {
  params: Promise<{ eventId: string; id: string }>;
}

const SEQUENCE_PHASES: ReadonlySet<string> = new Set(WEBINAR_SEQUENCE_PHASES);

/** Whether a webinar sequence row belongs to a date the webinar's session has since left. */
async function isStaleWebinarPhase(
  eventId: string,
  row: { emailType: string; scheduledFor: Date; filters: unknown; event: { settings: unknown } },
): Promise<boolean> {
  if (!SEQUENCE_PHASES.has(row.emailType)) return false;
  const anchorId = readWebinarSettings(row.event.settings)?.sessionId;
  if (!anchorId) return false;
  const anchor = await db.eventSession.findFirst({
    where: { id: anchorId, eventId },
    select: { startTime: true, endTime: true },
  });
  return anchor ? isSequenceRowForOtherDate(row, anchor) : false;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, id }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/emails/schedule/[id]/retry:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "communications.schedule", { route: "events/[eventId]/emails/schedule/[id]/retry:POST", eventId });
    if (!gate.ok) return gate.response;

    // Tenancy (Domain #18): swept ScheduledEmail retry rides the org lane.
    return await runWithTenant(orgGuard.orgId, async () => {

    // A certificate or survey send needs that operation's key too, as when it
    // was created (field-permissions.ts; review L2, Oct 6, 2026). The type is
    // read first and bound on the write, so it cannot change in between.
    const typeRow = await db.scheduledEmail.findFirst({
      where: { id, eventId, event: gate.eventWhere },
      select: { emailType: true, scheduledFor: true, filters: true, event: { select: { settings: true } } },
    });
    const typeKey = typeRow ? bulkEmailTypePermission(typeRow.emailType) : null;
    const typeGate = typeKey ? requirePermission(session, typeKey, { route: "events/[eventId]/emails/schedule/[id]/retry:POST", eventId }) : null;
    if (typeGate && !typeGate.ok) return typeGate.response;
    const eventWhere = typeGate ? { AND: [gate.eventWhere, typeGate.eventWhere] } : gate.eventWhere;

    // A webinar reminder made for a date the webinar has since moved away from must not go out: it would
    // tell people about the old date, beside the new date's own reminder (review MED, Oct 28, 2026).
    if (typeRow && await isStaleWebinarPhase(eventId, typeRow)) {
      apiLogger.warn({ msg: "scheduled-email:retry-rejected-webinar-moved", id, eventId, emailType: typeRow.emailType });
      return NextResponse.json(
        {
          error: "This reminder was for the webinar's earlier date. The new date has its own reminders, so it cannot be retried.",
          code: "WEBINAR_DATE_CHANGED",
        },
        { status: 409 },
      );
    }

    // Atomic retry — only succeeds if the row is still FAILED.
    const result = await db.scheduledEmail.updateMany({
      where: {
        id,
        eventId,
        // Review H-2: the PRIMARY write must carry the role-aware event
        // resolution, not just org scope — for WEBINARS this confines the
        // mutation to webinar events (the fallback read already did).
        event: eventWhere,
        ...(typeRow ? { emailType: typeRow.emailType } : {}),
        status: "FAILED",
      },
      data: {
        status: "PENDING",
        scheduledFor: new Date(Date.now() + 60 * 1000),
        retryCount: { increment: 1 },
        lastError: null,
        sentAt: null,
        // Hygiene (review C1): the next claim mints its own ownership token;
        // clearing the stale one makes "who owns this row" unambiguous.
        claimToken: null,
      },
    });

    if (result.count === 0) {
      const existing = await db.scheduledEmail.findFirst({
        where: { id, eventId, event: gate.eventWhere },
        select: { status: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "Scheduled email not found" }, { status: 404 });
      }
      apiLogger.warn({
        msg: "scheduled-email:retry-rejected",
        id,
        status: existing.status,
      });
      return NextResponse.json(
        { error: `Can only retry FAILED scheduled emails (current: ${existing.status})` },
        { status: 409 }
      );
    }

    const updated = await db.scheduledEmail.findUnique({ where: { id } });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "SCHEDULED_EMAIL_RETRIED",
          entityType: "ScheduledEmail",
          entityId: id,
          changes: { retryCount: updated?.retryCount ?? 0, ip: getClientIp(req) },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, msg: "Failed to write SCHEDULED_EMAIL_RETRIED audit log", id })
      );

    apiLogger.info({
      msg: "scheduled-email:retried",
      id,
      eventId,
      retryCount: updated?.retryCount ?? 0,
    });

    return NextResponse.json({ success: true, scheduledEmail: updated });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error retrying scheduled email" });
    return NextResponse.json({ error: "Failed to retry scheduled email" }, { status: 500 });
  }
}
