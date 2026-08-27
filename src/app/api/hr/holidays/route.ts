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
import { denyNonHr } from "@/hr/lib/hr-roles";
import { fromCalendarDate, isCalendarDate, toCalendarDate } from "@/hr/lib/hr-date";
import { ensurePublicHolidays2026 } from "@/hr/services/hr-seed-service";

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
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
      await ensurePublicHolidays2026(org.orgId);
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
