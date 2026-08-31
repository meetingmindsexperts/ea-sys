/**
 * DELETE /api/hr/holidays/[holidayId] — remove a public holiday.
 *
 * Refused while attendance is recorded on that date (409, with the count):
 * those rows were entered against a holiday, and taking the holiday away
 * changes what they mean without anyone looking at them. Clear or re-code
 * them first. The org binding is part of the WRITE (`deleteMany` with a
 * compound where), and the row is audited with its date and label (review M8).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { denyNonHr } from "@/hr/lib/hr-roles";
import { toCalendarDate } from "@/hr/lib/hr-date";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ holidayId: string }> },
) {
  const [session, { holidayId }] = await Promise.all([auth(), params]);
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/holiday:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/holiday", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/holiday" });
  if ("error" in org) return org.error;

  const rl = checkRateLimit({
    key: `hr-write:${session.user.id}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "hr/holiday", userId: session.user.id, limit: 300, windowSeconds: 3600 });
  }

  return runWithTenant(org.orgId, async () => {
    try {
      const holiday = await db.publicHoliday.findFirst({
        where: { id: holidayId, organizationId: org.orgId },
        select: { id: true, date: true, label: true },
      });
      if (!holiday) {
        apiLogger.warn({ msg: "hr/holiday:not-found", holidayId, userId: session.user.id });
        return NextResponse.json({ error: "Holiday not found." }, { status: 404 });
      }
      const inUse = await db.attendanceEntry.count({
        where: { organizationId: org.orgId, date: holiday.date },
      });
      if (inUse > 0) {
        apiLogger.warn({ msg: "hr/holiday:in-use", holidayId, inUse, userId: session.user.id });
        return NextResponse.json(
          {
            error: `${inUse} attendance ${inUse === 1 ? "record is" : "records are"} on ${toCalendarDate(holiday.date)}. Clear or re-code ${inUse === 1 ? "it" : "them"} before removing the holiday.`,
            code: "HOLIDAY_IN_USE",
            count: inUse,
          },
          { status: 409 },
        );
      }
      const { count } = await db.publicHoliday.deleteMany({
        where: { id: holidayId, organizationId: org.orgId },
      });
      if (count === 0) {
        apiLogger.warn({ msg: "hr/holiday:not-found", holidayId, userId: session.user.id });
        return NextResponse.json({ error: "Holiday not found." }, { status: 404 });
      }
      await db.auditLog
        .create({
          data: {
            userId: session.user.id,
            action: "DELETE",
            entityType: "PublicHoliday",
            entityId: holidayId,
            changes: { date: toCalendarDate(holiday.date), label: holiday.label },
          },
        })
        .catch((err) => apiLogger.error({ msg: "hr/holiday:audit-failed", err, holidayId }));
      apiLogger.info({ msg: "hr/holiday:deleted", holidayId, date: toCalendarDate(holiday.date), userId: session.user.id });
      return NextResponse.json({ ok: true });
    } catch (err) {
      apiLogger.error({ msg: "hr/holiday:delete-failed", err, holidayId });
      return NextResponse.json({ error: "Could not remove that holiday." }, { status: 500 });
    }
  });
}
