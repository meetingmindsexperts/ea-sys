/**
 * Recording attendance: one day, or a range.
 *
 * THE WRITE-TIME WINDOW CHECK IS THE POINT OF THIS SERVICE. The workbook could
 * only ignore an out-of-window row when counting; the app refuses it, so the
 * data cannot contain a leave day for somebody who did not work here. That is a
 * strictly better place to enforce it, and it is why the one-time import needs
 * an explicit bypass.
 *
 * HOW FAR A RANGE REACHES IS A POLICY, NOT A CALLER CHOICE. `rangeCoversCalendarDays`
 * (hr-constants.ts, owner ruling Aug 31 2026) decides it per leave category: an
 * ANNUAL block is charged for every calendar day in it, weekends included,
 * because the person was away and that is how every imported balance was
 * computed; ON_DUTY and COMP_OFF reach the weekend because they describe the
 * day itself; everything else, sick leave included, expands to working days
 * only. The explicit `includeNonWorkingDays` flag stays as an override.
 *
 * EVERY WRITE AND EVERY CLEAR RECORDS WHAT IT REPLACED. The audit row carries the
 * previous code of each overwritten day and the code of each deleted day, so a
 * drag that lands wrong can be put back from the trail alone. Codes only, never
 * remarks: free text is where a medical detail would land, and the trail
 * outlives the entry.
 */

import { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  type CalendarDate,
  dayOfWeek,
  daysBetween,
  eachDate,
  fromCalendarDate,
  isCalendarDate,
  toCalendarDate,
  yearOf,
} from "../lib/hr-date";
import { HR_DEFAULT_WEEKEND_DAYS, rangeCoversCalendarDays, HR_SICK_TIER_DAYS } from "../lib/hr-constants";
import { isWithinEmployment } from "../lib/hr-leave-year";
// One balance engine, asked rather than re-derived: it already knows about the
// opening seed, rule-derived days and half days, and a second count here would
// be the thing that disagrees with the summary screen.
import { getLeaveBalance } from "./leave-balance-service";

export type AttendanceErrorCode =
  | "INVALID_DATE"
  | "REVERSED_RANGE"
  | "RANGE_TOO_LONG"
  | "EMPLOYEE_NOT_FOUND"
  | "LEAVE_CODE_NOT_FOUND"
  | "OUTSIDE_EMPLOYMENT"
  | "NO_WORKING_DAYS"
  | "SICK_FULL_TIER_EXCEEDED"
  | "WRITE_TIMED_OUT"
  | "UNKNOWN";

export type AttendanceResult<T> =
  | { ok: true; result: T }
  | { ok: false; code: AttendanceErrorCode; message: string; meta?: Record<string, unknown> };

/**
 * A whole year for one person is 365; anything past that is a mistake or an
 * attempt to write the entire table in one request.
 */
const MAX_RANGE_DAYS = 366;

/**
 * The transaction budget for a range write. A full year is up to 366
 * statements in one interactive transaction, and Prisma's default is 5 s: at
 * 10 to 15 ms a statement through the pooler under load, the largest legitimate
 * range was exactly the one that failed, as an opaque UNKNOWN (review M12).
 * Still per-day upserts, because the before-snapshot is per day; the budget is
 * simply sized for the cap above.
 */
const TX_BUDGET = { maxWait: 10_000, timeout: 60_000 } as const;

/** Prisma P2028: the interactive transaction's timeout expired and it rolled back. */
function isTransactionTimeout(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2028";
}

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
  /**
   * Proceed even though the write takes the person past the 15 days of
   * full-pay sick leave that Art. 31 allows.
   *
   * Owner ruling, Aug 31 2026: WARN, do not convert. The system does not move
   * anyone into the half-pay tier by itself, because the tier is decided by
   * which code is recorded and silently counting an SL-F day at half pay would
   * make the grid say one thing while payroll pays another. So HR is told, and
   * HR chooses: record SL-H instead, or record SL-F anyway because they have a
   * reason. This flag is that second answer.
   */
  acknowledgeSickTier?: boolean;
}

function toNumber(v: unknown): number {
  return v instanceof Prisma.Decimal ? v.toNumber() : Number(v);
}

/**
 * What this write would do to the full-pay sick tier, or null when it cannot
 * be judged (no such employee, or the dates span no leave year we hold).
 *
 * Judged per LEAVE YEAR, because a range crossing New Year is two separate
 * entitlements and summing them would invent a limit nobody has. The worst
 * year wins, since it only takes one to cross.
 */
async function projectSickFullTier(params: {
  organizationId: string;
  employeeId: string;
  dates: CalendarDate[];
  newDayWeight: number;
  weekendDays: readonly number[];
}): Promise<{ leaveYear: number; used: number; adding: number; wouldBe: number } | null> {
  const byYear = new Map<number, CalendarDate[]>();
  for (const d of params.dates) {
    const y = yearOf(d);
    byYear.set(y, [...(byYear.get(y) ?? []), d]);
  }

  // What is already recorded on the days about to be rewritten. Without this,
  // re-saving a day that is already SL-F would read as a sixteenth day.
  const existing = await db.attendanceEntry.findMany({
    where: {
      organizationId: params.organizationId,
      employeeId: params.employeeId,
      date: { in: params.dates.map(fromCalendarDate) },
    },
    select: { date: true, leaveCode: { select: { countsAs: true, dayWeight: true } } },
  });
  const replacingByYear = new Map<number, number>();
  for (const e of existing) {
    if (e.leaveCode.countsAs !== "SICK_FULL") continue;
    const y = yearOf(toCalendarDate(e.date));
    replacingByYear.set(y, (replacingByYear.get(y) ?? 0) + toNumber(e.leaveCode.dayWeight));
  }

  let worst: { leaveYear: number; used: number; adding: number; wouldBe: number } | null = null;
  for (const [leaveYear, dates] of byYear) {
    const balance = await getLeaveBalance({
      organizationId: params.organizationId,
      employeeId: params.employeeId,
      leaveYear,
      weekendDays: params.weekendDays,
    });
    if (!balance || !balance.balance.employedInYear) continue;
    const used = balance.balance.sick.full.used - (replacingByYear.get(leaveYear) ?? 0);
    const adding = params.newDayWeight * dates.length;
    const wouldBe = Math.round((used + adding) * 10) / 10;
    if (!worst || wouldBe > worst.wouldBe) {
      worst = { leaveYear, used: Math.round(used * 10) / 10, adding, wouldBe };
    }
  }
  return worst;
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

  // Checked before the range is expanded, so a hundred-year request costs a
  // subtraction rather than 36,000 strings.
  if (daysBetween(input.from, to) + 1 > MAX_RANGE_DAYS) {
    return {
      ok: false,
      code: "RANGE_TOO_LONG",
      message: `A range may cover at most ${MAX_RANGE_DAYS} days.`,
    };
  }
  const dates = eachDate(input.from, to);

  const [employee, leaveCode] = await Promise.all([
    db.employee.findFirst({
      where: { id: input.employeeId, organizationId: input.organizationId },
      select: { id: true, joiningDate: true, exitDate: true },
    }),
    db.leaveCode.findFirst({
      where: { organizationId: input.organizationId, code: input.code, active: true },
      select: { id: true, code: true, countsAs: true, dayWeight: true },
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

  /*
   * The 15-day full-pay sick limit (Art. 31), as a WARNING rather than a
   * conversion. Owner ruling, Aug 31 2026.
   *
   * The tier is decided by which CODE is recorded, so moving somebody into
   * half pay automatically would mean the grid shows SL-F while payroll pays
   * half: the record would stop being the truth, which is the one property
   * this module is built on. Instead the write is refused once, with the
   * numbers, and HR decides. `acknowledgeSickTier` is them deciding.
   *
   * `used` comes from the ONE balance engine rather than a second count here,
   * so it already includes the opening seed, rule-derived days and half days
   * (SL-HD is 0.5 and also counts against this tier). Days being overwritten
   * are subtracted, or re-saving an existing sick day would look like adding
   * one.
   */
  if (leaveCode.countsAs === "SICK_FULL" && !input.acknowledgeSickTier) {
    const tier = await projectSickFullTier({
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      dates: target,
      newDayWeight: toNumber(leaveCode.dayWeight),
      weekendDays,
    });
    if (tier && tier.wouldBe > HR_SICK_TIER_DAYS.full) {
      return {
        ok: false,
        code: "SICK_FULL_TIER_EXCEEDED",
        message:
          `This takes ${tier.leaveYear} full-pay sick leave to ${tier.wouldBe} of ` +
          `${HR_SICK_TIER_DAYS.full} days. Beyond 15 the entitlement is half pay (SL-H).`,
        meta: {
          leaveYear: tier.leaveYear,
          used: tier.used,
          adding: tier.adding,
          wouldBe: tier.wouldBe,
          limit: HR_SICK_TIER_DAYS.full,
        },
      };
    }
  }

  try {
    // What each written day held BEFORE, read inside the same transaction as
    // the write. Without it an accidental overwrite (AL dragged across a
    // recorded sick week) was unrecoverable: the audit said what was written
    // and never what it replaced (review H5, Aug 31 2026).
    const overwritten = await tenantTransaction(async (tx) => {
      const existing = await tx.attendanceEntry.findMany({
        where: {
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          date: { in: target.map(fromCalendarDate) },
        },
        select: { date: true, leaveCode: { select: { code: true } } },
        orderBy: { date: "asc" },
      });
      const previous = existing.map((e) => ({
        date: toCalendarDate(e.date),
        previousCode: e.leaveCode.code,
      }));

      for (const date of target) {
        // One statement per day is what lets the snapshot above stay per day;
        // the transaction budget for the longest range is TX_BUDGET.
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
            // Touched only when the caller SAID something about remarks. The
            // grid never sends them, so re-coding a day used to null the note
            // that explained it. An explicit null still clears.
            ...(input.remarks !== undefined && { remarks: input.remarks?.trim() || null }),
            approvedById: input.actorUserId,
            source: input.source,
          },
        });
      }
      return previous;
    }, TX_BUDGET);

    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "AttendanceEntry",
          entityId: `employee:${input.employeeId}`,
          // CODES, never remarks. A medical detail would realistically land in
          // free text, and the audit trail outlives the entry. `overwritten`
          // lists only the days that already had a row, with the code they
          // held, which is exactly what a reversal needs.
          changes: {
            source: input.source,
            employeeId: input.employeeId,
            code: leaveCode.code,
            from: input.from,
            to,
            days: target.length,
            overwritten,
          },
        },
      })
      .catch((err) => apiLogger.error({ msg: "hr-attendance:audit-failed", err }));

    return { ok: true, result: { written: target.length, skipped } };
  } catch (err) {
    if (isTransactionTimeout(err)) {
      apiLogger.error({
        msg: "hr-attendance:write-timed-out",
        employeeId: input.employeeId,
        from: input.from,
        to,
        days: target.length,
      });
      return {
        ok: false,
        code: "WRITE_TIMED_OUT",
        message: `Saving ${target.length} days took too long and nothing was written. Try a shorter range.`,
      };
    }
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
  // The same ceiling a write has. Clearing is a hard delete, and without a cap
  // one request could erase a person's entire recorded history (review H5).
  if (daysBetween(input.from, to) + 1 > MAX_RANGE_DAYS) {
    return {
      ok: false,
      code: "RANGE_TOO_LONG",
      message: `A range may cover at most ${MAX_RANGE_DAYS} days.`,
    };
  }
  try {
    const where = {
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      date: { gte: fromCalendarDate(input.from), lte: fromCalendarDate(to) },
    };
    // Snapshot what is about to go, in the same transaction as the delete, so
    // the audit can put it back. Codes only, never remarks.
    const removed = await tenantTransaction(async (tx) => {
      const rows = await tx.attendanceEntry.findMany({
        where,
        select: { date: true, leaveCode: { select: { code: true } } },
        orderBy: { date: "asc" },
      });
      await tx.attendanceEntry.deleteMany({ where });
      return rows.map((r) => ({ date: toCalendarDate(r.date), code: r.leaveCode.code }));
    }, TX_BUDGET);
    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "DELETE",
          entityType: "AttendanceEntry",
          entityId: `employee:${input.employeeId}`,
          changes: {
            employeeId: input.employeeId,
            from: input.from,
            to,
            removed: removed.length,
            entries: removed,
          },
        },
      })
      .catch((err) => apiLogger.error({ msg: "hr-attendance:audit-failed", err }));
    return { ok: true, result: { removed: removed.length } };
  } catch (err) {
    if (isTransactionTimeout(err)) {
      apiLogger.error({ msg: "hr-attendance:clear-timed-out", employeeId: input.employeeId, from: input.from, to });
      return {
        ok: false,
        code: "WRITE_TIMED_OUT",
        message: "Clearing that range took too long and nothing was removed. Try a shorter range.",
      };
    }
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
