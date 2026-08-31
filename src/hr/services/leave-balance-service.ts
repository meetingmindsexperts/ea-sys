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
import { HR_DEFAULT_TIMEZONE } from "../lib/hr-constants";
import { leaveYearBounds } from "../lib/hr-leave-year";
import { ruleDerivedDays } from "../lib/hr-effective-status";
import { employedOnWhere } from "./employee-service";
import { computeLeaveBalance, type LeaveBalance } from "../lib/leave-balance";
import type { AttendanceRuleLike } from "../lib/attendance-rules";
import { EMPLOYEE_SELECT, toEmployeeView, type EmployeeView } from "./employee-service";

const DEFAULT_TIMEZONE = HR_DEFAULT_TIMEZONE;

/**
 * What the year-end roll carried into `leaveYear`, per employee. A grant is
 * the ONLY source of carry-in for any year other than an employee's seed year;
 * absent, the engine carries nothing in (see `BalanceEmployee.seedLeaveYear`).
 */
async function loadCarriedIn(
  organizationId: string,
  employeeIds: string[],
  leaveYear: number,
): Promise<Map<string, number>> {
  if (employeeIds.length === 0) return new Map();
  const grants = await db.leaveGrant.findMany({
    where: { organizationId, leaveYear, employeeId: { in: employeeIds } },
    select: { employeeId: true, carriedInDays: true },
  });
  return new Map(grants.map((g) => [g.employeeId, Number(g.carriedInDays)]));
}

export interface BalanceForEmployee {
  employee: EmployeeView;
  balance: LeaveBalance;
}


/**
 * Standing rules and public holidays, in the shape the resolver wants.
 *
 * Loaded once per balance query and shared across every employee in it: an org
 * has a handful of rules (thirteen would cover the imported year), so fetching
 * them per person would be 23 identical round trips for one screen.
 */
async function loadRuleContext(organizationId: string): Promise<{
  rules: (AttendanceRuleLike & { category: LeaveCategory; dayWeight: number })[];
  holidays: Set<CalendarDate>;
}> {
  const [ruleRows, holidayRows] = await Promise.all([
    db.attendanceRule.findMany({
      where: { organizationId },
      select: {
        id: true, scope: true, employeeId: true, startDate: true, endDate: true,
        leaveCode: { select: { code: true, countsAs: true, dayWeight: true } },
      },
    }),
    db.publicHoliday.findMany({ where: { organizationId }, select: { date: true } }),
  ]);
  return {
    rules: ruleRows.map((r) => ({
      id: r.id,
      scope: r.scope,
      employeeId: r.employeeId,
      code: r.leaveCode.code,
      startDate: toCalendarDate(r.startDate),
      endDate: r.endDate ? toCalendarDate(r.endDate) : null,
      category: r.leaveCode.countsAs as LeaveCategory,
      dayWeight: Number(r.leaveCode.dayWeight),
    })),
    holidays: new Set(holidayRows.map((h) => toCalendarDate(h.date))),
  };
}

/**
 * The rule-derived days for one employee, as balance entries.
 *
 * A rule carrying a leave code MUST count. Skipping this would let one
 * company-wide record hand every employee free annual leave, invisibly.
 */
function ruleEntriesFor(params: {
  employeeId: string;
  employment: { joiningDate: CalendarDate; exitDate?: CalendarDate | null };
  ctx: Awaited<ReturnType<typeof loadRuleContext>>;
  explicitDates: ReadonlySet<CalendarDate>;
  from: CalendarDate;
  to: CalendarDate;
  weekendDays?: readonly number[];
}) {
  const byId = new Map(params.ctx.rules.map((r) => [r.id, r]));
  return ruleDerivedDays({
    employeeId: params.employeeId,
    employment: params.employment,
    rules: params.ctx.rules,
    explicitDates: params.explicitDates,
    holidays: params.ctx.holidays,
    from: params.from,
    to: params.to,
    weekendDays: params.weekendDays,
  }).map((day) => {
    const rule = byId.get(day.ruleId)!;
    return { date: day.date, category: rule.category, dayWeight: rule.dayWeight };
  });
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

  const explicit = entries.map((e) => ({
    date: toCalendarDate(e.date),
    category: e.leaveCode.countsAs as LeaveCategory,
    dayWeight: Number(e.leaveCode.dayWeight),
  }));

  const [ruleCtx, carriedIn] = await Promise.all([
    loadRuleContext(params.organizationId),
    loadCarriedIn(params.organizationId, [employee.id], leaveYear),
  ]);
  const fromRules = ruleEntriesFor({
    employeeId: employee.id,
    employment: { joiningDate: employee.joiningDate, exitDate: employee.exitDate },
    ctx: ruleCtx,
    explicitDates: new Set(explicit.map((e) => e.date)),
    from: employee.joiningDate,
    to,
    weekendDays: params.weekendDays,
  });

  const balance = computeLeaveBalance({
    employee: {
      joiningDate: employee.joiningDate,
      exitDate: employee.exitDate,
      carryoverDays: employee.carryoverDays,
      openingSickUsed: employee.openingSickUsed,
      openingCompOff: employee.openingCompOff,
      annualEntitlementDays: employee.annualEntitlementDays,
      seedLeaveYear: employee.seedLeaveYear,
    },
    leaveYear,
    asOf,
    entries: [...explicit, ...fromRules],
    carriedInDays: carriedIn.get(employee.id),
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
      // "Currently employed" is decided by the last working day, as the
      // employees list decides it, so the two cannot disagree about a leaver.
      ...(params.includeExited ? {} : employedOnWhere(asOf)),
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

  const [ruleCtx, carriedIn] = await Promise.all([
    loadRuleContext(params.organizationId),
    loadCarriedIn(params.organizationId, rows.map((r) => r.id), leaveYear),
  ]);

  return rows.map((row) => {
    const employee = toEmployeeView(row);
    const explicit = byEmployee.get(row.id) ?? [];
    const fromRules = ruleEntriesFor({
      employeeId: row.id,
      employment: { joiningDate: employee.joiningDate, exitDate: employee.exitDate },
      ctx: ruleCtx,
      explicitDates: new Set(explicit.map((e) => e.date)),
      from: employee.joiningDate,
      to,
      weekendDays: params.weekendDays,
    });
    return {
      employee,
      balance: computeLeaveBalance({
        employee: {
          joiningDate: employee.joiningDate,
          exitDate: employee.exitDate,
          carryoverDays: employee.carryoverDays,
          openingSickUsed: employee.openingSickUsed,
          openingCompOff: employee.openingCompOff,
          annualEntitlementDays: employee.annualEntitlementDays,
          seedLeaveYear: employee.seedLeaveYear,
        },
        leaveYear,
        asOf,
        entries: [...explicit, ...fromRules],
        carriedInDays: carriedIn.get(row.id),
        weekendDays: params.weekendDays,
      }),
    };
  });
}
