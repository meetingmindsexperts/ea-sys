/**
 * The DB-backed entry point to the balance engine.
 *
 * This file queries; `src/hr/lib/leave-balance.ts` does the maths. The split is
 * what lets the hard part be tested against the real reconciliation figures
 * without a database, and it is why there is exactly one implementation of the
 * maths rather than one per surface.
 */

import type { LeaveCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { type CalendarDate, fromCalendarDate, toCalendarDate, todayInTimezone, yearOf } from "../lib/hr-date";
import { leaveYearBounds } from "../lib/hr-leave-year";
import { computeLeaveBalance, type LeaveBalance } from "../lib/leave-balance";
import { EMPLOYEE_SELECT, toEmployeeView, type EmployeeView } from "./employee-service";

/** The org's own working week. HR reads dates in the week its people work. */
const DEFAULT_TIMEZONE = "Asia/Dubai";

export interface BalanceForEmployee {
  employee: EmployeeView;
  balance: LeaveBalance;
}

export async function getLeaveBalance(params: {
  organizationId: string;
  employeeId: string;
  leaveYear?: number;
  asOf?: CalendarDate;
  weekendDays?: readonly number[];
}): Promise<BalanceForEmployee | null> {
  const asOf = params.asOf ?? todayInTimezone(DEFAULT_TIMEZONE);
  const leaveYear = params.leaveYear ?? yearOf(asOf);

  const row = await db.employee.findFirst({
    where: { id: params.employeeId, organizationId: params.organizationId },
    select: EMPLOYEE_SELECT,
  });
  if (!row) return null;
  const employee = toEmployeeView(row);

  // Comp-off is a RUNNING balance with no year bound, so entries are read from
  // the joining date rather than from the start of the leave year. Bounding this
  // query to the year would silently reset everyone's comp-off each January.
  const { to } = leaveYearBounds(leaveYear);
  const entries = await db.attendanceEntry.findMany({
    where: {
      organizationId: params.organizationId,
      employeeId: params.employeeId,
      date: { gte: fromCalendarDate(employee.joiningDate), lte: fromCalendarDate(to) },
    },
    select: { date: true, leaveCode: { select: { countsAs: true, dayWeight: true } } },
  });

  const balance = computeLeaveBalance({
    employee: {
      joiningDate: employee.joiningDate,
      exitDate: employee.exitDate,
      carryoverDays: employee.carryoverDays,
      openingSickUsed: employee.openingSickUsed,
      openingCompOff: employee.openingCompOff,
    },
    leaveYear,
    asOf,
    entries: entries.map((e) => ({
      date: toCalendarDate(e.date),
      category: e.leaveCode.countsAs as LeaveCategory,
      dayWeight: Number(e.leaveCode.dayWeight),
    })),
    weekendDays: params.weekendDays,
  });

  return { employee, balance };
}

/**
 * Balances for every employee in the org, for the leave-summary table.
 *
 * Two queries in total, not two per employee: the entries are fetched in one go
 * and grouped in memory. At 25 people the difference is invisible; at 500 the
 * per-employee version is 1,000 round trips.
 */
export async function getOrgLeaveSummary(params: {
  organizationId: string;
  leaveYear?: number;
  asOf?: CalendarDate;
  includeExited?: boolean;
  weekendDays?: readonly number[];
}): Promise<BalanceForEmployee[]> {
  const asOf = params.asOf ?? todayInTimezone(DEFAULT_TIMEZONE);
  const leaveYear = params.leaveYear ?? yearOf(asOf);
  const { to } = leaveYearBounds(leaveYear);

  const rows = await db.employee.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.includeExited ? {} : { status: "ACTIVE" }),
    },
    select: EMPLOYEE_SELECT,
    orderBy: { empCode: "asc" },
  });
  if (rows.length === 0) return [];

  const entries = await db.attendanceEntry.findMany({
    where: {
      organizationId: params.organizationId,
      employeeId: { in: rows.map((r) => r.id) },
      date: { lte: fromCalendarDate(to) },
    },
    select: {
      employeeId: true,
      date: true,
      leaveCode: { select: { countsAs: true, dayWeight: true } },
    },
  });

  const byEmployee = new Map<string, { date: CalendarDate; category: LeaveCategory; dayWeight: number }[]>();
  for (const e of entries) {
    const list = byEmployee.get(e.employeeId) ?? [];
    list.push({
      date: toCalendarDate(e.date),
      category: e.leaveCode.countsAs as LeaveCategory,
      dayWeight: Number(e.leaveCode.dayWeight),
    });
    byEmployee.set(e.employeeId, list);
  }

  return rows.map((row) => {
    const employee = toEmployeeView(row);
    return {
      employee,
      balance: computeLeaveBalance({
        employee: {
          joiningDate: employee.joiningDate,
          exitDate: employee.exitDate,
          carryoverDays: employee.carryoverDays,
          openingSickUsed: employee.openingSickUsed,
          openingCompOff: employee.openingCompOff,
        },
        leaveYear,
        asOf,
        entries: byEmployee.get(row.id) ?? [],
        weekendDays: params.weekendDays,
      }),
    };
  });
}
