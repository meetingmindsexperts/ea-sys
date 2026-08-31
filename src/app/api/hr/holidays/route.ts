/**
 * GET  /api/hr/holidays — the org's public holidays.
 * POST /api/hr/holidays — add one.
 *
 * Never generated. Islamic dates move with the moon, so HR confirms each year by
 * hand; a generated guess would be wrong in a way that silently shifts which
 * days count as working days, and therefore how much leave somebody has taken.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { denyNonHr } from "@/hr/lib/hr-roles";
import { fromCalendarDate, isCalendarDate, toCalendarDate, calendarDateSchema } from "@/hr/lib/hr-date";
import { ensurePublicHolidays } from "@/hr/services/hr-seed-service";

const createSchema = z.object({
  date: calendarDateSchema,
  label: z.string().min(1).max(120),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/holidays:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/holidays" });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/holidays" });
  if ("error" in org) return org.error;

  return runWithTenant(org.orgId, async () => {
    try {
      await ensurePublicHolidays(org.orgId);
      const rows = await db.publicHoliday.findMany({
        where: { organizationId: org.orgId },
        select: { id: true, date: true, label: true },
        orderBy: { date: "asc" },
      });
      return NextResponse.json({
        holidays: rows.map((r) => ({ ...r, date: toCalendarDate(r.date) })),
      });
    } catch (err) {
      apiLogger.error({ msg: "hr/holidays:failed", err, userId: session.user.id });
      return NextResponse.json({ error: "Could not load holidays." }, { status: 500 });
    }
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/holidays:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/holidays", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/holidays" });
  if ("error" in org) return org.error;

  // The same write bucket as every other HR write: a holiday moves every
  // rule-derived day and the working-day expansion for the whole org.
  const rl = checkRateLimit({
    key: `hr-write:${session.user.id}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "hr/holidays", userId: session.user.id, limit: 300, windowSeconds: 3600 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/holidays:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!isCalendarDate(parsed.data.date)) {
    apiLogger.warn({ msg: "hr/holidays:impossible-date", date: parsed.data.date });
    return NextResponse.json({ error: "That is not a real date.", code: "INVALID_DATE" }, { status: 400 });
  }

  return runWithTenant(org.orgId, async () => {
    try {
      const row = await db.publicHoliday.create({
        data: {
          organizationId: org.orgId,
          date: fromCalendarDate(parsed.data.date),
          label: parsed.data.label.trim(),
        },
        select: { id: true, date: true, label: true },
      });
      // Audited (review M8): a holiday changes what a rule charges and how much
      // leave a range costs, for everyone, and nothing said who added it.
      await db.auditLog
        .create({
          data: {
            userId: session.user.id,
            action: "CREATE",
            entityType: "PublicHoliday",
            entityId: row.id,
            changes: { date: parsed.data.date, label: row.label },
          },
        })
        .catch((err) => apiLogger.error({ msg: "hr/holidays:audit-failed", err, holidayId: row.id }));
      apiLogger.info({ msg: "hr/holidays:created", holidayId: row.id, date: parsed.data.date, userId: session.user.id });
      return NextResponse.json(
        { holiday: { ...row, date: toCalendarDate(row.date) } },
        { status: 201 },
      );
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        apiLogger.warn({ msg: "hr/holidays:duplicate", date: parsed.data.date });
        return NextResponse.json(
          { error: "That date is already a holiday.", code: "DUPLICATE_DATE" },
          { status: 409 },
        );
      }
      apiLogger.error({ msg: "hr/holidays:create-failed", err });
      return NextResponse.json({ error: "Could not add that holiday." }, { status: 500 });
    }
  });
}
