/**
 * Employee records: create, update, and the exit flow.
 *
 * Errors as values, per src/services/README.md. The service owns the
 * transaction and the audit row; the route owns auth, Zod and the HTTP status.
 *
 * TWO INVARIANTS, both enforced on the RESULTING record rather than on the
 * patch, so that changing one field cannot leave the pair inconsistent
 * (review M2 and M3, Aug 31 2026):
 *
 *   1. `status` and `exitDate` agree. A leaver (RESIGNED, TERMINATED) has a
 *      last working day; an ACTIVE record never carries one that has already
 *      passed. Before this the two halves of the module read different fields
 *      (lists filtered on status, every window check read exitDate), so
 *      RESIGNED with no date was hidden from every list while the balance
 *      engine treated the person as employed forever. A future last working
 *      day with the status still ACTIVE is somebody serving notice, and stays.
 *   2. The employment window never moves under recorded attendance. Moving the
 *      joining date later or the exit date earlier would leave rows the grid
 *      hides (NOT_EMPLOYED beats an explicit entry), the balance excludes and
 *      nothing warns about: a mistaken exit on 31 October for somebody with
 *      leave recorded through 20 November silently dropped their taken figure.
 *      The write is refused with the count; the operator clears or moves those
 *      days first. There is deliberately no force flag: it would only mint the
 *      stranded rows the refusal exists to prevent.
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  type CalendarDate,
  fromCalendarDate,
  isCalendarDate,
  toCalendarDate,
  todayInTimezone,
  yearOf,
} from "../lib/hr-date";
import { HR_DEFAULT_TIMEZONE } from "../lib/hr-constants";
import { capCarryover } from "../lib/leave-balance";

export type EmployeeErrorCode =
  | "INVALID_DATE"
  | "EXIT_BEFORE_JOINING"
  | "EXIT_DATE_REQUIRED"
  | "LEAVER_STATUS_REQUIRED"
  | "ENTRIES_OUTSIDE_WINDOW"
  | "USER_NOT_IN_ORG"
  | "EMP_CODE_TAKEN"
  | "EMPLOYEE_NOT_FOUND"
  | "USER_ALREADY_LINKED"
  | "UNKNOWN";

export type EmployeeStatus = "ACTIVE" | "RESIGNED" | "TERMINATED";

/**
 * "Currently employed", as a Prisma where-fragment: no last working day, or one
 * still to come. Every default list reads THIS rather than `status`, because
 * status is a human record that time does not update: somebody whose notice
 * ended yesterday is still RESIGNED-with-a-date today, and a filter on status
 * alone kept a leaver in the active payroll table until a person noticed.
 */
export function employedOnWhere(today: CalendarDate) {
  return { OR: [{ exitDate: null }, { exitDate: { gte: fromCalendarDate(today) } }] };
}

/**
 * Invariant 1, judged on the resulting pair. Returned as an error value so
 * create and update share one rule and cannot drift.
 */
export function checkEmploymentPair(
  status: EmployeeStatus,
  exitDate: CalendarDate | null,
  today: CalendarDate,
): EmployeeResult<null> {
  if (status !== "ACTIVE" && !exitDate) {
    return {
      ok: false,
      code: "EXIT_DATE_REQUIRED",
      message: "A resigned or terminated employee needs a last working day. Clear the status to Active instead if they are staying.",
    };
  }
  if (status === "ACTIVE" && exitDate && exitDate < today) {
    return {
      ok: false,
      code: "LEAVER_STATUS_REQUIRED",
      message: `The last working day (${exitDate}) has passed. Set the status to Resigned or Terminated, or clear the date.`,
    };
  }
  return { ok: true, employee: null };
}

export type EmployeeResult<T> =
  | { ok: true; employee: T }
  | { ok: false; code: EmployeeErrorCode; message: string };

/**
 * A login may be linked only if it belongs to THIS organisation. Without the
 * check, on the platform, org B could bind its employee to an org A login (a
 * squat that then 409s org A's own record) and probe user ids for existence;
 * on master an employee could be tied to a REGISTRANT (review M5). A
 * non-member and a non-existent id get the same answer, so this is not an
 * existence oracle either.
 */
async function lookupOrgUser(
  organizationId: string,
  userId: string,
): Promise<EmployeeResult<null>> {
  const user = await db.user.findFirst({ where: { id: userId, organizationId }, select: { id: true } });
  if (!user) {
    return {
      ok: false,
      code: "USER_NOT_IN_ORG",
      message: "That login is not a member of this organisation.",
    };
  }
  return { ok: true, employee: null };
}

type AuditScalar = string | number | boolean | null;

/**
 * The audit row for an edit: the fields that CHANGED, with their old and new
 * values, and `notes` recorded as changed but never quoted. The full record
 * used to be copied in twice on every save, free text included, into a table
 * with no prune job; the attendance audit already refused remarks for the
 * same reason, that free text about a person will hold medical detail and the
 * trail outlives the row (review M7). Empty when nothing changed.
 */
export function employeeAuditDiff(
  before: EmployeeView,
  after: EmployeeView,
): Record<string, { from: AuditScalar; to: AuditScalar } | "changed"> {
  const diff: Record<string, { from: AuditScalar; to: AuditScalar } | "changed"> = {};
  for (const key of Object.keys(after) as (keyof EmployeeView)[]) {
    if (key === "id") continue;
    const from = before[key] as AuditScalar;
    const to = after[key] as AuditScalar;
    if (from === to) continue;
    diff[key] = key === "notes" ? "changed" : { from, to };
  }
  return diff;
}

export interface CreateEmployeeInput {
  organizationId: string;
  actorUserId: string;
  source: "ui" | "mcp" | "import";
  empCode: string;
  name: string;
  department?: string | null;
  jobTitle?: string | null;
  joiningDate: CalendarDate;
  exitDate?: CalendarDate | null;
  carryoverDays?: number;
  openingSickUsed?: number;
  openingCompOff?: number;
  /** Null clears the override and returns the person to the standard rule. */
  annualEntitlementDays?: number | null;
  /**
   * The leave year the seeds (`carryoverDays`, `openingSickUsed`) belong to.
   * Defaults to the current leave year, which is when a figure typed at
   * creation is true. The workbook import passes 2026 explicitly.
   */
  seedLeaveYear?: number;
  userId?: string | null;
  notes?: string | null;
  /**
   * Honoured, not dropped: a historical leaver can be created in one call. It
   * used to be accepted by the route and silently ignored here (review M2).
   * Defaults to ACTIVE, and the status/exit-date pair is checked either way.
   */
  status?: EmployeeStatus;
}

/** The shape every HR read returns, with dates already flattened to strings. */
export interface EmployeeView {
  id: string;
  empCode: string;
  name: string;
  department: string | null;
  jobTitle: string | null;
  joiningDate: CalendarDate;
  exitDate: CalendarDate | null;
  status: string;
  carryoverDays: number;
  openingSickUsed: number;
  openingCompOff: number;
  annualEntitlementDays: number | null;
  seedLeaveYear: number | null;
  userId: string | null;
  notes: string | null;
}

type EmployeeRow = {
  id: string; empCode: string; name: string; department: string | null;
  jobTitle: string | null; joiningDate: Date; exitDate: Date | null; status: string;
  carryoverDays: unknown; openingSickUsed: unknown; openingCompOff: unknown;
  annualEntitlementDays: unknown; seedLeaveYear: number | null;
  userId: string | null; notes: string | null;
};

/** Prisma `Decimal` to a plain number. Day counts are small; precision is safe. */
function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function toEmployeeView(row: EmployeeRow): EmployeeView {
  return {
    id: row.id,
    empCode: row.empCode,
    name: row.name,
    department: row.department,
    jobTitle: row.jobTitle,
    joiningDate: toCalendarDate(row.joiningDate),
    exitDate: row.exitDate ? toCalendarDate(row.exitDate) : null,
    status: row.status,
    carryoverDays: num(row.carryoverDays),
    openingSickUsed: num(row.openingSickUsed),
    openingCompOff: num(row.openingCompOff),
    annualEntitlementDays:
      row.annualEntitlementDays === null || row.annualEntitlementDays === undefined
        ? null
        : num(row.annualEntitlementDays),
    seedLeaveYear: row.seedLeaveYear ?? null,
    userId: row.userId,
    notes: row.notes,
  };
}

export const EMPLOYEE_SELECT = {
  id: true, empCode: true, name: true, department: true, jobTitle: true,
  joiningDate: true, exitDate: true, status: true, carryoverDays: true,
  openingSickUsed: true, openingCompOff: true, annualEntitlementDays: true,
  seedLeaveYear: true, userId: true, notes: true,
} as const;

export async function createEmployee(
  input: CreateEmployeeInput,
): Promise<EmployeeResult<EmployeeView>> {
  if (!isCalendarDate(input.joiningDate)) {
    return { ok: false, code: "INVALID_DATE", message: "Joining date is not a valid date." };
  }
  if (input.exitDate && !isCalendarDate(input.exitDate)) {
    return { ok: false, code: "INVALID_DATE", message: "Exit date is not a valid date." };
  }
  if (input.exitDate && input.exitDate < input.joiningDate) {
    return {
      ok: false,
      code: "EXIT_BEFORE_JOINING",
      message: "The exit date cannot be before the joining date.",
    };
  }
  const status: EmployeeStatus = input.status ?? "ACTIVE";
  const pair = checkEmploymentPair(status, input.exitDate ?? null, todayInTimezone(HR_DEFAULT_TIMEZONE));
  if (!pair.ok) return pair;
  if (input.userId) {
    const linked = await lookupOrgUser(input.organizationId, input.userId);
    if (!linked.ok) return linked;
  }

  try {
    const row = await db.employee.create({
      data: {
        organizationId: input.organizationId,
        empCode: input.empCode.trim(),
        name: input.name.trim(),
        department: input.department?.trim() || null,
        jobTitle: input.jobTitle?.trim() || null,
        joiningDate: fromCalendarDate(input.joiningDate),
        exitDate: input.exitDate ? fromCalendarDate(input.exitDate) : null,
        status,
        // Capped on the way in, so a bad seed cannot store a figure the balance
        // engine would then have to keep re-capping on every read.
        carryoverDays: capCarryover(input.carryoverDays ?? 0),
        openingSickUsed: input.openingSickUsed ?? 0,
        openingCompOff: input.openingCompOff ?? 0,
        annualEntitlementDays: input.annualEntitlementDays ?? null,
        // The seeds are true for the year they were typed in, and no other.
        seedLeaveYear: input.seedLeaveYear ?? yearOf(todayInTimezone(HR_DEFAULT_TIMEZONE)),
        userId: input.userId ?? null,
        notes: input.notes?.trim() || null,
      },
      select: EMPLOYEE_SELECT,
    });

    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "CREATE",
          entityType: "Employee",
          entityId: row.id,
          changes: { source: input.source, empCode: row.empCode, name: row.name },
        },
      })
      .catch((err) => apiLogger.error({ msg: "hr-employee:audit-failed", err }));

    return { ok: true, employee: toEmployeeView(row) };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2002") {
      const target = String((err as { meta?: { target?: unknown } })?.meta?.target ?? "");
      if (target.includes("userId")) {
        return {
          ok: false,
          code: "USER_ALREADY_LINKED",
          message: "That login is already linked to another employee.",
        };
      }
      return {
        ok: false,
        code: "EMP_CODE_TAKEN",
        message: "An employee with that code already exists.",
      };
    }
    apiLogger.error({ msg: "hr-employee:create-failed", err });
    return { ok: false, code: "UNKNOWN", message: "Could not create the employee." };
  }
}

export interface UpdateEmployeeInput {
  organizationId: string;
  actorUserId: string;
  employeeId: string;
  /**
   * Stamped on the audit row. A workbook re-sync writes "import", and the
   * next sync reads it back to tell its own earlier write from a person's
   * decision, which it must never overwrite (scripts/hr-sync-plan.ts).
   */
  source?: "ui" | "mcp" | "import";
  patch: Partial<
    Pick<
      CreateEmployeeInput,
      | "name" | "department" | "jobTitle" | "joiningDate" | "exitDate"
      | "carryoverDays" | "openingSickUsed" | "openingCompOff" | "notes"
      | "annualEntitlementDays" | "userId"
    >
  > & { status?: EmployeeStatus };
}

export async function updateEmployee(
  input: UpdateEmployeeInput,
): Promise<EmployeeResult<EmployeeView>> {
  const existing = await db.employee.findFirst({
    where: { id: input.employeeId, organizationId: input.organizationId },
    select: EMPLOYEE_SELECT,
  });
  if (!existing) {
    return { ok: false, code: "EMPLOYEE_NOT_FOUND", message: "Employee not found." };
  }

  const p = input.patch;
  const joining = p.joiningDate ?? toCalendarDate(existing.joiningDate);
  const exit =
    p.exitDate === undefined
      ? existing.exitDate
        ? toCalendarDate(existing.exitDate)
        : null
      : p.exitDate;

  if (!isCalendarDate(joining) || (exit && !isCalendarDate(exit))) {
    return { ok: false, code: "INVALID_DATE", message: "That is not a valid date." };
  }
  // Checked against the RESULTING state, not against the patch, so changing one
  // of the two dates cannot leave the pair inconsistent.
  if (exit && exit < joining) {
    return {
      ok: false,
      code: "EXIT_BEFORE_JOINING",
      message: "The exit date cannot be before the joining date.",
    };
  }
  const status = (p.status ?? existing.status) as EmployeeStatus;
  const pair = checkEmploymentPair(status, exit, todayInTimezone(HR_DEFAULT_TIMEZONE));
  if (!pair.ok) return pair;

  // Invariant 2: the window may not move under recorded attendance. Only a
  // date change can shrink it, so only a date change pays for the query.
  if (p.joiningDate !== undefined || p.exitDate !== undefined) {
    const stranded = await db.attendanceEntry.aggregate({
      where: {
        organizationId: input.organizationId,
        employeeId: input.employeeId,
        OR: [
          { date: { lt: fromCalendarDate(joining) } },
          ...(exit ? [{ date: { gt: fromCalendarDate(exit) } }] : []),
        ],
      },
      _count: { _all: true },
      _min: { date: true },
      _max: { date: true },
    });
    const n = stranded._count._all;
    if (n > 0) {
      const first = stranded._min.date ? toCalendarDate(stranded._min.date) : "?";
      const last = stranded._max.date ? toCalendarDate(stranded._max.date) : "?";
      return {
        ok: false,
        code: "ENTRIES_OUTSIDE_WINDOW",
        message:
          `${n} recorded day${n === 1 ? "" : "s"} (${first === last ? first : `${first} to ${last}`}) ` +
          `would fall outside the new employment dates. Clear or move ${n === 1 ? "it" : "them"} first.`,
      };
    }
  }

  // Null unlinks; a new id must belong to this org. Neither was possible
  // before: the PATCH schema omitted the field, so a wrong link was permanent.
  if (p.userId) {
    const linked = await lookupOrgUser(input.organizationId, p.userId);
    if (!linked.ok) return linked;
  }

  try {
    // Bound to the org IN THE WRITE, not only in the read above: `updateMany`
    // takes a compound where, so a refactor that drops the read cannot turn
    // this into a cross-tenant write (review M6; the same shape
    // `deleteAttendanceRule` already uses, and the tenancy harness pins it).
    const { count } = await db.employee.updateMany({
      where: { id: input.employeeId, organizationId: input.organizationId },
      data: {
        ...(p.name !== undefined && { name: p.name.trim() }),
        ...(p.department !== undefined && { department: p.department?.trim() || null }),
        ...(p.jobTitle !== undefined && { jobTitle: p.jobTitle?.trim() || null }),
        ...(p.joiningDate !== undefined && { joiningDate: fromCalendarDate(joining) }),
        ...(p.exitDate !== undefined && {
          exitDate: exit ? fromCalendarDate(exit) : null,
        }),
        ...(p.carryoverDays !== undefined && { carryoverDays: capCarryover(p.carryoverDays) }),
        ...(p.openingSickUsed !== undefined && { openingSickUsed: p.openingSickUsed }),
        ...(p.openingCompOff !== undefined && { openingCompOff: p.openingCompOff }),
        // null is meaningful: it clears the agreement and restores the rule.
        ...(p.annualEntitlementDays !== undefined && {
          annualEntitlementDays: p.annualEntitlementDays,
        }),
        ...(p.notes !== undefined && { notes: p.notes?.trim() || null }),
        ...(p.status !== undefined && { status: p.status }),
        ...(p.userId !== undefined && { userId: p.userId }),
      },
    });
    if (count === 0) {
      return { ok: false, code: "EMPLOYEE_NOT_FOUND", message: "Employee not found." };
    }
    const row = await db.employee.findFirst({
      where: { id: input.employeeId, organizationId: input.organizationId },
      select: EMPLOYEE_SELECT,
    });
    if (!row) {
      return { ok: false, code: "EMPLOYEE_NOT_FOUND", message: "Employee not found." };
    }

    const after = toEmployeeView(row);
    const changed = employeeAuditDiff(toEmployeeView(existing), after);
    if (Object.keys(changed).length > 0) {
      await db.auditLog
        .create({
          data: {
            userId: input.actorUserId,
            action: "UPDATE",
            entityType: "Employee",
            entityId: row.id,
            changes: { changed, source: input.source ?? "ui" },
          },
        })
        .catch((err) => apiLogger.error({ msg: "hr-employee:audit-failed", err }));
    }

    return { ok: true, employee: after };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2002" && String((err as { meta?: { target?: unknown } })?.meta?.target ?? "").includes("userId")) {
      return {
        ok: false,
        code: "USER_ALREADY_LINKED",
        message: "That login is already linked to another employee.",
      };
    }
    apiLogger.error({ msg: "hr-employee:update-failed", err, employeeId: input.employeeId });
    return { ok: false, code: "UNKNOWN", message: "Could not update the employee." };
  }
}

/**
 * The exit flow: set the last working day and the reason.
 *
 * The employment record is NEVER deleted or soft-hidden. It is the evidence for
 * end-of-service gratuity and leave encashment, and it outlives both the login
 * and the employment.
 */
export async function setEmployeeExit(input: {
  organizationId: string;
  actorUserId: string;
  employeeId: string;
  exitDate: CalendarDate;
  status: Exclude<EmployeeStatus, "ACTIVE">;
}): Promise<EmployeeResult<EmployeeView>> {
  return updateEmployee({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    employeeId: input.employeeId,
    patch: { exitDate: input.exitDate, status: input.status },
  });
}
