/**
 * Recording attendance: one day, or a range.
 *
 * THE WRITE-TIME WINDOW CHECK IS THE POINT OF THIS SERVICE. The workbook could
 * only ignore an out-of-window row when counting; the app refuses it, so the
 * data cannot contain a leave day for somebody who did not work here. That is a
 * strictly better place to enforce it, and it is why the one-time import needs
 * an explicit bypass.
 *
 * A BULK RANGE EXPANDS TO WORKING DAYS ONLY. "AL from 7 to 18 September" means
 * the working days in that span, not twelve calendar days: weekends and public
 * holidays inside a holiday are not annual leave, and charging them would
 * quietly cost the employee four days.
 */

import { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  type CalendarDate,
  dayOfWeek,
  eachDate,
  fromCalendarDate,
  isCalendarDate,
  toCalendarDate,
} from "../lib/hr-date";
import { HR_DEFAULT_WEEKEND_DAYS, rangeCoversCalendarDays } from "../lib/hr-constants";
import { isWithinEmployment } from "../lib/hr-leave-year";

export type AttendanceErrorCode =
  | "INVALID_DATE"
  | "REVERSED_RANGE"
  | "RANGE_TOO_LONG"
  | "EMPLOYEE_NOT_FOUND"
  | "LEAVE_CODE_NOT_FOUND"
  | "OUTSIDE_EMPLOYMENT"
  | "NO_WORKING_DAYS"
  | "UNKNOWN";

export type AttendanceResult<T> =
  | { ok: true; result: T }
  | { ok: false; code: AttendanceErrorCode; message: string; meta?: Record<string, unknown> };

/**
 * A whole year for one person is 365; anything past that is a mistake or an
 * attempt to write the entire table in one request.
 */
const MAX_RANGE_DAYS = 366;

export interface SetAttendanceInput {
  organizationId: string;
  actorUserId: string;
  source: "ui" | "mcp" | "import" | "cron";
  employeeId: string;
  from: CalendarDate;
  /** Omit for a single day. */
  to?: CalendarDate;
  code: string;
  remarks?: string | null;
  /**
   * Write every calendar day in the range, not only working days. Used by the
   * codes that describe the day itself (OD on a Saturday, PH) rather than an
   * absence from work.
   */
  includeNonWorkingDays?: boolean;
  weekendDays?: readonly number[];
}

export async function setAttendance(
  input: SetAttendanceInput,
): Promise<AttendanceResult<{ written: number; skipped: CalendarDate[] }>> {
  const to = input.to ?? input.from;
  if (!isCalendarDate(input.from) || !isCalendarDate(to)) {
    return { ok: false, code: "INVALID_DATE", message: "That is not a valid date." };
  }
  if (to < input.from) {
    return { ok: false, code: "REVERSED_RANGE", message: "The end date is before the start date." };
  }

  const dates = eachDate(input.from, to);
  if (dates.length > MAX_RANGE_DAYS) {
    return {
      ok: false,
      code: "RANGE_TOO_LONG",
      message: `A range may cover at most ${MAX_RANGE_DAYS} days.`,
    };
  }

  const [employee, leaveCode] = await Promise.all([
    db.employee.findFirst({
      where: { id: input.employeeId, organizationId: input.organizationId },
      select: { id: true, joiningDate: true, exitDate: true },
    }),
    db.leaveCode.findFirst({
      where: { organizationId: input.organizationId, code: input.code, active: true },
      select: { id: true, code: true, countsAs: true },
    }),
  ]);
  if (!employee) {
    return { ok: false, code: "EMPLOYEE_NOT_FOUND", message: "Employee not found." };
  }
  if (!leaveCode) {
    return {
      ok: false,
      code: "LEAVE_CODE_NOT_FOUND",
      message: `No active leave code "${input.code}".`,
    };
  }

  const employment = {
    joiningDate: toCalendarDate(employee.joiningDate),
    exitDate: employee.exitDate ? toCalendarDate(employee.exitDate) : null,
  };

  // Refused, not silently trimmed. Somebody asking to record leave outside the
  // employment window has made a mistake, and quietly writing the part that fits
  // would hide it.
  const outside = dates.filter((d) => !isWithinEmployment(d, employment));
  if (outside.length > 0) {
    return {
      ok: false,
      code: "OUTSIDE_EMPLOYMENT",
      message: "Some of those dates fall outside this person's employment.",
      meta: { outside: outside.slice(0, 10), joiningDate: employment.joiningDate, exitDate: employment.exitDate },
    };
  }

  const weekendDays = input.weekendDays ?? HR_DEFAULT_WEEKEND_DAYS;
  let skipped: CalendarDate[] = [];
  let target = dates;
  // Policy lives HERE, not at the call site, so every caller — the grid, MCP,
  // an import — gets the same answer. The explicit flag stays as an override.
  const coversCalendarDays =
    input.includeNonWorkingDays ?? rangeCoversCalendarDays(leaveCode.countsAs);
  if (!coversCalendarDays) {
    const holidays = new Set(
      (
        await db.publicHoliday.findMany({
          where: {
            organizationId: input.organizationId,
            date: { gte: fromCalendarDate(input.from), lte: fromCalendarDate(to) },
          },
          select: { date: true },
        })
      ).map((h) => toCalendarDate(h.date)),
    );
    const isWorkingDay = (d: CalendarDate) =>
      !weekendDays.includes(dayOfWeek(d)) && !holidays.has(d);
    target = dates.filter(isWorkingDay);
    skipped = dates.filter((d) => !isWorkingDay(d));
  }

  if (target.length === 0) {
    return {
      ok: false,
      code: "NO_WORKING_DAYS",
      message: "That range contains no working days.",
      meta: { skipped },
    };
  }

  try {
    await tenantTransaction(async (tx) => {
      for (const date of target) {
        await tx.attendanceEntry.upsert({
          where: {
            organizationId_employeeId_date: {
              organizationId: input.organizationId,
              employeeId: input.employeeId,
              date: fromCalendarDate(date),
            },
          },
          create: {
            organizationId: input.organizationId,
            employeeId: input.employeeId,
            date: fromCalendarDate(date),
            leaveCodeId: leaveCode.id,
            remarks: input.remarks?.trim() || null,
            approvedById: input.actorUserId,
            source: input.source,
          },
          update: {
            leaveCodeId: leaveCode.id,
            remarks: input.remarks?.trim() || null,
            approvedById: input.actorUserId,
            source: input.source,
          },
        });
      }
    });

    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "AttendanceEntry",
          entityId: `employee:${input.employeeId}`,
          // The CODE, never the remarks. A medical detail would realistically
          // land in free text, and the audit trail outlives the entry.
          changes: {
            source: input.source,
            employeeId: input.employeeId,
            code: leaveCode.code,
            from: input.from,
            to,
            days: target.length,
          },
        },
      })
      .catch((err) => apiLogger.error({ msg: "hr-attendance:audit-failed", err }));

    return { ok: true, result: { written: target.length, skipped } };
  } catch (err) {
    apiLogger.error({
      msg: "hr-attendance:write-failed",
      err,
      employeeId: input.employeeId,
      from: input.from,
      to,
    });
    return { ok: false, code: "UNKNOWN", message: "Could not record that attendance." };
  }
}

/** Remove entries, returning each affected day to its derived status. */
export async function clearAttendance(input: {
  organizationId: string;
  actorUserId: string;
  employeeId: string;
  from: CalendarDate;
  to?: CalendarDate;
}): Promise<AttendanceResult<{ removed: number }>> {
  const to = input.to ?? input.from;
  if (!isCalendarDate(input.from) || !isCalendarDate(to)) {
    return { ok: false, code: "INVALID_DATE", message: "That is not a valid date." };
  }
  if (to < input.from) {
    return { ok: false, code: "REVERSED_RANGE", message: "The end date is before the start date." };
  }
  try {
    const { count } = await db.attendanceEntry.deleteMany({
      where: {
        organizationId: input.organizationId,
        employeeId: input.employeeId,
        date: { gte: fromCalendarDate(input.from), lte: fromCalendarDate(to) },
      },
    });
    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "DELETE",
          entityType: "AttendanceEntry",
          entityId: `employee:${input.employeeId}`,
          changes: { employeeId: input.employeeId, from: input.from, to, removed: count },
        },
      })
      .catch((err) => apiLogger.error({ msg: "hr-attendance:audit-failed", err }));
    return { ok: true, result: { removed: count } };
  } catch (err) {
    apiLogger.error({ msg: "hr-attendance:clear-failed", err, employeeId: input.employeeId });
    return { ok: false, code: "UNKNOWN", message: "Could not clear that attendance." };
  }
}

/** Entries for a date range, flattened for the grid and the balance engine. */
export async function listAttendance(params: {
  organizationId: string;
  from: CalendarDate;
  to: CalendarDate;
  employeeId?: string;
}): Promise<
  { employeeId: string; date: CalendarDate; code: string; category: string; dayWeight: number; remarks: string | null }[]
> {
  const rows = await db.attendanceEntry.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.employeeId && { employeeId: params.employeeId }),
      date: { gte: fromCalendarDate(params.from), lte: fromCalendarDate(params.to) },
    },
    select: {
      employeeId: true,
      date: true,
      remarks: true,
      leaveCode: { select: { code: true, countsAs: true, dayWeight: true } },
    },
    orderBy: [{ employeeId: "asc" }, { date: "asc" }],
  });
  return rows.map((r) => ({
    employeeId: r.employeeId,
    date: toCalendarDate(r.date),
    code: r.leaveCode.code,
    category: r.leaveCode.countsAs,
    dayWeight:
      r.leaveCode.dayWeight instanceof Prisma.Decimal
        ? r.leaveCode.dayWeight.toNumber()
        : Number(r.leaveCode.dayWeight),
    remarks: r.remarks,
  }));
}
