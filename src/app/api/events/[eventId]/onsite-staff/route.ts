import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { updateEventSettings } from "@/lib/event-settings";
import { getClientIp } from "@/lib/security";

/**
 * Per-event ONSITE (registration-desk) staff assignment.
 *
 * ONSITE is org-bound but scoped per-event via `Event.settings.onsiteUserIds`
 * (mirrors `reviewerUserIds` — see buildEventAccessWhere). A temp desk worker
 * sees ONLY the events they're assigned to here. These endpoints add/remove a
 * user id from that array; the central management UI lives in org
 * Settings → Onsite Staff and calls these per event toggle.
 *
 * Guarded by `denyReviewer` (ADMIN / ORGANIZER / SUPER_ADMIN only). The target
 * user must be an ONSITE account in the caller's org — you can't assign an
 * arbitrary user id.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const assignSchema = z.object({ userId: z.string().min(1).max(100) });

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settings = (event.settings as Record<string, unknown>) || {};
    const onsiteUserIds = (settings.onsiteUserIds as string[]) || [];
    const onsiteStaff = onsiteUserIds.length
      ? await db.user.findMany({
          where: { id: { in: onsiteUserIds } },
          select: { id: true, firstName: true, lastName: true, email: true, emailVerified: true },
        })
      : [];

    return NextResponse.json({
      onsiteStaff: onsiteStaff.map((u) => ({ ...u, active: !!u.emailVerified })),
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing onsite staff" });
    return NextResponse.json({ error: "Failed to list onsite staff" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "events/onsite-staff:zod-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { userId } = parsed.data;

    // Event must belong to the caller's org; the target must be an ONSITE
    // account in the SAME org (can't assign an arbitrary / cross-org user id).
    const [event, targetUser] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: orgGuard.orgId },
        select: { id: true },
      }),
      db.user.findFirst({
        where: { id: userId, organizationId: orgGuard.orgId, role: "ONSITE" },
        select: { id: true },
      }),
    ]);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!targetUser) {
      return NextResponse.json(
        { error: "Onsite staff account not found in this organization.", code: "ONSITE_USER_NOT_FOUND" },
        { status: 404 },
      );
    }

    // Atomic append against the freshly-locked array (dedup with a Set — a
    // concurrent add of the same user can't create a duplicate).
    await updateEventSettings(eventId, (cur) => ({
      ...cur,
      onsiteUserIds: Array.from(new Set([...((cur.onsiteUserIds as string[]) ?? []), userId])),
    }));

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Event",
          entityId: eventId,
          changes: { onsiteStaffAssigned: userId, ip: getClientIp(req) },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "onsite-staff:assign-audit-failed", eventId, userId }));

    apiLogger.info({ msg: "onsite-staff:assigned", eventId, userId, by: session.user.id });
    return NextResponse.json({ success: true, assigned: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error assigning onsite staff" });
    return NextResponse.json({ error: "Failed to assign onsite staff" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session);
    if (denied) return denied;

    const userId = new URL(req.url).searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    await updateEventSettings(eventId, (cur) => ({
      ...cur,
      onsiteUserIds: ((cur.onsiteUserIds as string[]) ?? []).filter((id) => id !== userId),
    }));

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Event",
          entityId: eventId,
          changes: { onsiteStaffUnassigned: userId, ip: getClientIp(req) },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "onsite-staff:unassign-audit-failed", eventId, userId }));

    apiLogger.info({ msg: "onsite-staff:unassigned", eventId, userId, by: session.user.id });
    return NextResponse.json({ success: true, unassigned: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error unassigning onsite staff" });
    return NextResponse.json({ error: "Failed to unassign onsite staff" }, { status: 500 });
  }
}
