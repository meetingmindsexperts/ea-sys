/**
 * GET    /api/hr/attendance?from&to&employeeId  — the grid's entries.
 * PUT    /api/hr/attendance                      — record a day or a range.
 * DELETE /api/hr/attendance                      — clear a day or a range.
 *
 * The GET returns only the entries that EXIST. Ordinary working days have no
 * row: the grid derives them (weekend to OFF, holiday to PH, otherwise P) using
 * the same resolver the balance engine uses. Sending 9,125 derived rows down the
 * wire to render a year would be the workbook's own mistake in a new place.
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
import { toCalendarDate, calendarDateSchema } from "@/hr/lib/hr-date";
import {
  clearAttendance,
  listAttendance,
  setAttendance,
  type AttendanceErrorCode,
} from "@/hr/services/attendance-service";
import { listAttendanceRules } from "@/hr/services/attendance-rule-service";

const ISO_DATE = calendarDateSchema;

const HTTP_STATUS_FOR_ATTENDANCE_ERROR: Record<AttendanceErrorCode, number> = {
  INVALID_DATE: 400,
  REVERSED_RANGE: 400,
  RANGE_TOO_LONG: 400,
  EMPLOYEE_NOT_FOUND: 404,
  LEAVE_CODE_NOT_FOUND: 400,
  // 409, not 400: the request is well formed and the CONFLICT is with the
  // employment window, which is a state the caller can see and correct.
  OUTSIDE_EMPLOYMENT: 409,
  NO_WORKING_DAYS: 400,
  // 409, not 400: the request is well formed and the CONFLICT is with a limit
  // the caller can see and deliberately pass (`acknowledgeSickTier`). Art. 31
  // gives 15 days at full pay; beyond that the entitlement is half pay, and
  // the owner's ruling is that HR chooses the code rather than the system
  // silently converting it.
  SICK_FULL_TIER_EXCEEDED: 409,
  // Nothing was written; the caller can retry with a smaller range.
  WRITE_TIMED_OUT: 503,
  UNKNOWN: 500,
};

const writeSchema = z.object({
  employeeId: z.string().cuid(),
  from: ISO_DATE,
  to: ISO_DATE.optional(),
  code: z.string().min(1).max(20),
  remarks: z.string().max(500).nullish(),
  includeNonWorkingDays: z.boolean().optional(),
});

const clearSchema = z.object({
  employeeId: z.string().cuid(),
  from: ISO_DATE,
  to: ISO_DATE.optional(),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/attendance:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/attendance" });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/attendance" });
  if ("error" in org) return org.error;

  const sp = req.nextUrl.searchParams;
  const parsed = z
    .object({ from: ISO_DATE, to: ISO_DATE, employeeId: z.string().cuid().optional() })
    .safeParse({
      from: sp.get("from"),
      to: sp.get("to"),
      employeeId: sp.get("employeeId") ?? undefined,
    });
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/attendance:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return runWithTenant(org.orgId, async () => {
    try {
      const [entries, holidays, rules] = await Promise.all([
        listAttendance({ organizationId: org.orgId, ...parsed.data }),
        db.publicHoliday.findMany({
          where: { organizationId: org.orgId },
          select: { date: true, label: true },
          orderBy: { date: "asc" },
        }),
        listAttendanceRules({ organizationId: org.orgId }),
      ]);
      return NextResponse.json({
        entries,
        // Holidays AND rules travel with the entries so the grid derives the
        // same answer the balance engine does, rather than deriving its own
        // from a different holiday list or a stale set of rules.
        holidays: holidays.map((h) => ({ date: toCalendarDate(h.date), label: h.label })),
        rules,
      });
    } catch (err) {
      apiLogger.error({ msg: "hr/attendance:list-failed", err, userId: session.user.id });
      return NextResponse.json({ error: "Could not load attendance." }, { status: 500 });
    }
  });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/attendance:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/attendance", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/attendance" });
  if ("error" in org) return org.error;

  const rl = checkRateLimit({
    key: `hr-write:${session.user.id}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "hr/attendance", userId: session.user.id, limit: 300, windowSeconds: 3600 });
  }

  const body = await req.json().catch(() => null);
  const parsed = writeSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/attendance:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return runWithTenant(org.orgId, async () => {
    const result = await setAttendance({
      organizationId: org.orgId,
      actorUserId: session.user.id,
      source: "ui",
      ...parsed.data,
    });
    if (!result.ok) {
      apiLogger.warn({
        msg: "hr/attendance:write-rejected",
        code: result.code,
        employeeId: parsed.data.employeeId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status: HTTP_STATUS_FOR_ATTENDANCE_ERROR[result.code] },
      );
    }
    return NextResponse.json(result.result);
  });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/attendance:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/attendance", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/attendance" });
  if ("error" in org) return org.error;

  // Same bucket as the writes: a clear is a hard delete and deserves at least
  // the throttle a write has (review H5, Aug 31 2026).
  const rl = checkRateLimit({
    key: `hr-write:${session.user.id}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "hr/attendance:DELETE", userId: session.user.id, limit: 300, windowSeconds: 3600 });
  }

  const body = await req.json().catch(() => null);
  const parsed = clearSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/attendance:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return runWithTenant(org.orgId, async () => {
    const result = await clearAttendance({
      organizationId: org.orgId,
      actorUserId: session.user.id,
      ...parsed.data,
    });
    if (!result.ok) {
      apiLogger.warn({
        msg: "hr/attendance:clear-rejected",
        code: result.code,
        employeeId: parsed.data.employeeId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: HTTP_STATUS_FOR_ATTENDANCE_ERROR[result.code] },
      );
    }
    return NextResponse.json(result.result);
  });
}
