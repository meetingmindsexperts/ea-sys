/**
 * Employee records: create, update, and the exit flow.
 *
 * Errors as values, per src/services/README.md. The service owns the
 * transaction and the audit row; the route owns auth, Zod and the HTTP status.
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { type CalendarDate, fromCalendarDate, isCalendarDate, toCalendarDate } from "../lib/hr-date";
import { capCarryover } from "../lib/leave-balance";

export type EmployeeErrorCode =
  | "INVALID_DATE"
  | "EXIT_BEFORE_JOINING"
  | "EMP_CODE_TAKEN"
  | "EMPLOYEE_NOT_FOUND"
  | "USER_ALREADY_LINKED"
  | "UNKNOWN";

export type EmployeeResult<T> =
  | { ok: true; employee: T }
  | { ok: false; code: EmployeeErrorCode; message: string };

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
  userId?: string | null;
  notes?: string | null;
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
  userId: string | null;
  notes: string | null;
}

type EmployeeRow = {
  id: string; empCode: string; name: string; department: string | null;
  jobTitle: string | null; joiningDate: Date; exitDate: Date | null; status: string;
  carryoverDays: unknown; openingSickUsed: unknown; openingCompOff: unknown;
  annualEntitlementDays: unknown;
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
    userId: row.userId,
    notes: row.notes,
  };
}

export const EMPLOYEE_SELECT = {
  id: true, empCode: true, name: true, department: true, jobTitle: true,
  joiningDate: true, exitDate: true, status: true, carryoverDays: true,
  openingSickUsed: true, openingCompOff: true, annualEntitlementDays: true,
  userId: true, notes: true,
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
        // Capped on the way in, so a bad seed cannot store a figure the balance
        // engine would then have to keep re-capping on every read.
        carryoverDays: capCarryover(input.carryoverDays ?? 0),
        openingSickUsed: input.openingSickUsed ?? 0,
        openingCompOff: input.openingCompOff ?? 0,
        annualEntitlementDays: input.annualEntitlementDays ?? null,
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
  patch: Partial<
    Pick<
      CreateEmployeeInput,
      | "name" | "department" | "jobTitle" | "joiningDate" | "exitDate"
      | "carryoverDays" | "openingSickUsed" | "openingCompOff" | "notes"
      | "annualEntitlementDays"
    >
  > & { status?: "ACTIVE" | "RESIGNED" | "TERMINATED" };
}

export async function updateEmployee(
  input: UpdateEmployeeInput,
): Promise<EmployeeResult<EmployeeView>> {
  // Bound to the org in the WHERE, not merely checked beforehand: the binding
  // has to be part of the write, or a later refactor can drop the check without
  // anything failing.
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

  try {
    const row = await db.employee.update({
      where: { id: input.employeeId },
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
      },
      select: EMPLOYEE_SELECT,
    });

    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "Employee",
          entityId: row.id,
          // Prisma's Json input needs an index signature, which a named
          // interface does not have. Spreading gives the same object as a plain
          // record without loosening the exported type.
          changes: {
            before: { ...toEmployeeView(existing) },
            after: { ...toEmployeeView(row) },
          },
        },
      })
      .catch((err) => apiLogger.error({ msg: "hr-employee:audit-failed", err }));

    return { ok: true, employee: toEmployeeView(row) };
  } catch (err) {
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
  status: "RESIGNED" | "TERMINATED";
}): Promise<EmployeeResult<EmployeeView>> {
  return updateEmployee({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    employeeId: input.employeeId,
    patch: { exitDate: input.exitDate, status: input.status },
  });
}
