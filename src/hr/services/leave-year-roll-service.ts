/**
 * THE YEAR-END ROLL: what one leave year hands to the next.
 *
 * WHY IT EXISTS. The leave year is the calendar year (docs/HR_MODULE_PLAN.md
 * §3.1), so nothing accumulates across years inside the ledger; last year
 * arrives as a carried-in figure. Until this service existed nothing WROTE that
 * figure: `LeaveGrant` had no writer, `planYearRoll` had no caller, and every
 * year silently reused the go-live seeds, so on 1 January every overdraft or
 * surplus would have vanished and the opening sick figure would have been
 * charged again (review H6, Aug 31 2026).
 *
 * WHAT IT WRITES. For every employee employed at some point in `fromYear` and
 * still employed on 1 January of `toYear`, one `LeaveGrant` row for `toYear`:
 * `carriedInDays` = the closing annual balance of `fromYear` as at 31 December,
 * capped in one direction by `planYearRoll` (a positive is capped at 30, a
 * negative carries in full: a cap on a debt would forgive it), and
 * `entitlementDays` = what the standard rule gives on 1 January, recorded for
 * the record rather than read back (the gate MOVES during the year, so the
 * engine keeps computing entitlement live).
 *
 * IDEMPOTENT BY CONSTRUCTION. Every write is an upsert on
 * `(organizationId, employeeId, leaveYear)`, and the closing balance is
 * recomputed from the rows each time, so the worker re-runs it every night
 * through January and a December leave day entered on 5 January simply
 * corrects the grant. Nothing on `Employee` is ever overwritten: the seeds stay
 * as typed, scoped to their own year by `seedLeaveYear`.
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { HR_ANNUAL_ENTITLEMENT_DAYS } from "../lib/hr-constants";
import { hasCompletedFirstYear, leaveYearBounds } from "../lib/hr-leave-year";
import { planYearRoll } from "../lib/leave-balance";
import { getOrgLeaveSummary } from "./leave-balance-service";

export interface YearRollResult {
  fromYear: number;
  toYear: number;
  /** Grants written (created or refreshed). */
  granted: number;
  /** Employees skipped: not employed in `fromYear`, or gone before `toYear`. */
  skipped: number;
  /** Employees whose positive balance was trimmed to the carry-over cap. */
  capped: { employeeId: string; empCode: string; closing: number; carried: number }[];
}

export async function rollLeaveYear(params: {
  organizationId: string;
  fromYear: number;
  /** Null for the worker: the grant rows and the log line are the record. */
  actorUserId: string | null;
  source: "ui" | "cron";
}): Promise<YearRollResult> {
  const { organizationId, fromYear } = params;
  const toYear = fromYear + 1;
  const { to: closingDate } = leaveYearBounds(fromYear);
  const { from: openingDate } = leaveYearBounds(toYear);

  // The closing balance of every person, leavers included: somebody who left
  // in December still closes the year, they just get no grant for the next.
  const rows = await getOrgLeaveSummary({
    organizationId,
    leaveYear: fromYear,
    asOf: closingDate,
    includeExited: true,
  });

  let granted = 0;
  let skipped = 0;
  const capped: YearRollResult["capped"] = [];

  for (const { employee, balance } of rows) {
    if (!balance.employedInYear) { skipped++; continue; }
    if (employee.exitDate && employee.exitDate < openingDate) { skipped++; continue; }
    // NEVER roll INTO somebody's seed year. Their carry-in for that year IS the
    // typed seed: the system holds no data before it, so a computed closing
    // balance for the year before would be "30 minus nothing" and a grant
    // would quietly replace every imported carry-over with +30. Caught while
    // verifying the summary button, which offers "2025 -> 2026" on the go-live
    // year.
    if (employee.seedLeaveYear !== null && employee.seedLeaveYear >= toYear) { skipped++; continue; }

    const plan = planYearRoll(balance);
    const entitlementDays = hasCompletedFirstYear(employee.joiningDate, openingDate)
      ? HR_ANNUAL_ENTITLEMENT_DAYS
      : 0;

    await db.leaveGrant.upsert({
      where: {
        organizationId_employeeId_leaveYear: {
          organizationId,
          employeeId: employee.id,
          leaveYear: toYear,
        },
      },
      create: {
        organizationId,
        employeeId: employee.id,
        leaveYear: toYear,
        entitlementDays,
        carriedInDays: plan.carryForwardDays,
      },
      update: {
        entitlementDays,
        carriedInDays: plan.carryForwardDays,
        grantedAt: new Date(),
      },
    });
    granted++;
    if (plan.capped) {
      capped.push({
        employeeId: employee.id,
        empCode: employee.empCode,
        closing: balance.annual.balance,
        carried: plan.carryForwardDays,
      });
    }
  }

  const result: YearRollResult = { fromYear, toYear, granted, skipped, capped };

  // One audit row per run, not per grant: the grants themselves are the
  // per-person record, and `grantedAt` says when. Counts plus the capped set,
  // because a trimmed carry-over is the one outcome somebody will ask about.
  await db.auditLog
    .create({
      data: {
        userId: params.actorUserId,
        action: "UPDATE",
        entityType: "LeaveGrant",
        entityId: `year:${toYear}`,
        changes: {
          source: params.source,
          fromYear,
          toYear,
          granted,
          skipped,
          capped: capped.map((c) => ({ empCode: c.empCode, closing: c.closing, carried: c.carried })),
        },
      },
    })
    .catch((err) => apiLogger.error({ msg: "hr/year-roll:audit-failed", err, toYear }));

  apiLogger.info({
    msg: "hr/year-roll:done",
    source: params.source,
    fromYear,
    toYear,
    granted,
    skipped,
    capped: capped.length,
  });
  return result;
}
