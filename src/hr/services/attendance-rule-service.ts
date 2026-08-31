/**
 * Standing attendance rules: create, list, end.
 *
 * A rule is the answer to a measurement. The imported workbook holds 386
 * work-from-home days, of which 252 are twelve company-wide dates and 120 belong
 * to one permanently remote person. Recording those as 372 rows was not a
 * recording habit, it was the absence of a way to say "the company" or
 * "always" — so this service exists to store the 13 decisions instead.
 *
 * It stores NOTHING derived. No day is written when a rule is created and no day
 * is deleted when one is removed; the grid and the balance engine resolve rules
 * at read time through `hr-effective-status.ts`. That is what keeps a rule
 * reversible: ending one restores exactly the days it was covering, because
 * those days were never rows in the first place.
 */

import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  type CalendarDate,
  fromCalendarDate,
  isCalendarDate,
  toCalendarDate,
} from "../lib/hr-date";
import type { AttendanceRuleScope } from "../lib/attendance-rules";

export type AttendanceRuleErrorCode =
  | "INVALID_DATE"
  | "REVERSED_RANGE"
  | "EMPLOYEE_REQUIRED"
  | "EMPLOYEE_NOT_FOUND"
  | "LEAVE_CODE_NOT_FOUND"
  | "RULE_NOT_FOUND"
  | "UNKNOWN";

export type AttendanceRuleResult<T> =
  | { ok: true; result: T }
  | { ok: false; code: AttendanceRuleErrorCode; message: string; meta?: Record<string, unknown> };

export interface AttendanceRuleView {
  id: string;
  scope: AttendanceRuleScope;
  employeeId: string | null;
  employeeName: string | null;
  code: string;
  category: string;
  dayWeight: number;
  startDate: CalendarDate;
  endDate: CalendarDate | null;
  label: string;
  createdAt: string;
}

const RULE_SELECT = {
  id: true,
  scope: true,
  employeeId: true,
  startDate: true,
  endDate: true,
  label: true,
  createdAt: true,
  employee: { select: { name: true } },
  leaveCode: { select: { code: true, countsAs: true, dayWeight: true } },
} as const;

type RuleRow = {
  id: string;
  scope: AttendanceRuleScope;
  employeeId: string | null;
  startDate: Date;
  endDate: Date | null;
  label: string;
  createdAt: Date;
  employee: { name: string } | null;
  leaveCode: { code: string; countsAs: string; dayWeight: unknown };
};

export function toRuleView(row: RuleRow): AttendanceRuleView {
  return {
    id: row.id,
    scope: row.scope,
    employeeId: row.employeeId,
    employeeName: row.employee?.name ?? null,
    code: row.leaveCode.code,
    category: row.leaveCode.countsAs,
    dayWeight: Number(row.leaveCode.dayWeight),
    startDate: toCalendarDate(row.startDate),
    endDate: row.endDate ? toCalendarDate(row.endDate) : null,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Every rule in the org.
 *
 * Deliberately NOT filtered to a date window. A rule with no end date has to be
 * returned whatever window is being viewed, and one that has ended still needs
 * to be visible so somebody can see why last month looks the way it does. The
 * whole set is a handful of rows: thirteen would cover the imported year.
 */
export async function listAttendanceRules(params: {
  organizationId: string;
  employeeId?: string;
}): Promise<AttendanceRuleView[]> {
  const rows = await db.attendanceRule.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.employeeId && {
        OR: [{ scope: "ORG" as const }, { employeeId: params.employeeId }],
      }),
    },
    select: RULE_SELECT,
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(toRuleView);
}

export interface CreateAttendanceRuleInput {
  organizationId: string;
  actorUserId: string;
  source: AttendanceRuleSource;
  scope: AttendanceRuleScope;
  /** Required when scope is EMPLOYEE, ignored otherwise. */
  employeeId?: string | null;
  code: string;
  startDate: CalendarDate;
  /** Omit or null for an open-ended standing arrangement. */
  endDate?: CalendarDate | null;
  label: string;
}

export async function createAttendanceRule(
  input: CreateAttendanceRuleInput,
): Promise<AttendanceRuleResult<AttendanceRuleView>> {
  if (!isCalendarDate(input.startDate)) {
    return { ok: false, code: "INVALID_DATE", message: "That is not a valid start date." };
  }
  if (input.endDate != null && !isCalendarDate(input.endDate)) {
    return { ok: false, code: "INVALID_DATE", message: "That is not a valid end date." };
  }
  if (input.endDate != null && input.endDate < input.startDate) {
    return {
      ok: false,
      code: "REVERSED_RANGE",
      message: "The end date is before the start date.",
    };
  }
  // Enforced here rather than by the database, because a conditional NOT NULL is
  // not expressible in Postgres without a check constraint that Prisma cannot
  // model. An ORG rule with a stray employeeId would silently become a personal
  // one, which is the wrong direction to fail in.
  if (input.scope === "EMPLOYEE" && !input.employeeId) {
    return {
      ok: false,
      code: "EMPLOYEE_REQUIRED",
      message: "A standing arrangement needs a person.",
    };
  }
  const employeeId = input.scope === "EMPLOYEE" ? input.employeeId! : null;

  const [employee, leaveCode] = await Promise.all([
    employeeId
      ? db.employee.findFirst({
          where: { id: employeeId, organizationId: input.organizationId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    db.leaveCode.findFirst({
      where: { organizationId: input.organizationId, code: input.code, active: true },
      select: { id: true, code: true },
    }),
  ]);
  if (employeeId && !employee) {
    return { ok: false, code: "EMPLOYEE_NOT_FOUND", message: "Employee not found." };
  }
  if (!leaveCode) {
    return {
      ok: false,
      code: "LEAVE_CODE_NOT_FOUND",
      message: `No active leave code "${input.code}".`,
    };
  }

  try {
    const created = await tenantTransaction(async (tx) =>
      tx.attendanceRule.create({
        data: {
          organizationId: input.organizationId,
          scope: input.scope,
          employeeId,
          leaveCodeId: leaveCode.id,
          startDate: fromCalendarDate(input.startDate),
          endDate: input.endDate ? fromCalendarDate(input.endDate) : null,
          label: input.label.trim() || (input.scope === "ORG" ? "Company day" : "Standing"),
          createdById: input.actorUserId,
          source: input.source,
        },
        select: RULE_SELECT,
      }),
    );

    await db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "CREATE",
          entityType: "AttendanceRule",
          entityId: created.id,
          changes: {
            source: input.source,
            scope: input.scope,
            employeeId,
            code: leaveCode.code,
            startDate: input.startDate,
            endDate: input.endDate ?? null,
            // Not the label: it is the organiser's free text, and the trail
            // outlives the rule (review M7). Scope, code and dates are the
            // facts a reversal needs.
          },
        },
      })
      .catch((err) =>
        apiLogger.error({ msg: "hr/attendance-rule:audit-failed", err, ruleId: created.id }),
      );

    apiLogger.info({
      msg: "hr/attendance-rule:created",
      ruleId: created.id,
      scope: input.scope,
      code: leaveCode.code,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
    });
    return { ok: true, result: toRuleView(created) };
  } catch (err) {
    apiLogger.error({ msg: "hr/attendance-rule:create-failed", err, scope: input.scope });
    return { ok: false, code: "UNKNOWN", message: "Could not save that rule." };
  }
}

/**
 * Remove a rule.
 *
 * A hard delete, and safe as one BECAUSE the rule stored no days. Removing it
 * puts the grid back exactly where it was: the days it was covering become
 * assumed-present again, since they were derived all along. Nothing an operator
 * typed is lost, because a rule is not a record of what somebody typed.
 */
/** Who performed a rule change, recorded on the audit row. */
export type AttendanceRuleSource = "ui" | "mcp" | "import" | "cron";

export async function deleteAttendanceRule(params: {
  organizationId: string;
  actorUserId: string;
  ruleId: string;
  /**
   * Who is doing this. It used to be hardcoded `"ui"` on the audit row, which
   * is true of the only caller today and would quietly mislabel the first MCP
   * or import one: the trail would say a person clicked a button when nobody
   * did. Every sibling in this service already takes it, so the field was
   * asserting something the caller had not said.
   */
  source: AttendanceRuleSource;
}): Promise<AttendanceRuleResult<{ id: string }>> {
  try {
    const deleted = await tenantTransaction(async (tx) => {
      // Snapshot INSIDE the transaction that removes it: a company-wide AL
      // shutdown being deleted changes every balance in the org, and the audit
      // used to say only that a rule went (review M7).
      const snapshot = await tx.attendanceRule.findFirst({
        where: { id: params.ruleId, organizationId: params.organizationId },
        select: {
          scope: true, employeeId: true, startDate: true, endDate: true,
          leaveCode: { select: { code: true } },
        },
      });
      // Compound where: the org binding is part of the WRITE, not a preceding
      // read, so a cross-tenant id cannot be deleted even if the caller skipped
      // its own lookup.
      const res = await tx.attendanceRule.deleteMany({
        where: { id: params.ruleId, organizationId: params.organizationId },
      });
      return { count: res.count, snapshot };
    });
    if (deleted.count === 0) {
      apiLogger.warn({
        msg: "hr/attendance-rule:not-found",
        ruleId: params.ruleId,
        userId: params.actorUserId,
      });
      return { ok: false, code: "RULE_NOT_FOUND", message: "That rule no longer exists." };
    }

    await db.auditLog
      .create({
        data: {
          userId: params.actorUserId,
          action: "DELETE",
          entityType: "AttendanceRule",
          entityId: params.ruleId,
          changes: {
            source: params.source,
            scope: deleted.snapshot?.scope ?? null,
            employeeId: deleted.snapshot?.employeeId ?? null,
            code: deleted.snapshot?.leaveCode.code ?? null,
            startDate: deleted.snapshot ? toCalendarDate(deleted.snapshot.startDate) : null,
            endDate: deleted.snapshot?.endDate ? toCalendarDate(deleted.snapshot.endDate) : null,
          },
        },
      })
      .catch((err) =>
        apiLogger.error({ msg: "hr/attendance-rule:audit-failed", err, ruleId: params.ruleId }),
      );

    apiLogger.info({ msg: "hr/attendance-rule:deleted", ruleId: params.ruleId });
    return { ok: true, result: { id: params.ruleId } };
  } catch (err) {
    apiLogger.error({ msg: "hr/attendance-rule:delete-failed", err, ruleId: params.ruleId });
    return { ok: false, code: "UNKNOWN", message: "Could not remove that rule." };
  }
}
