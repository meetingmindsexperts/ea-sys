/**
 * The HR year-end roll, as a worker tick.
 *
 * Runs every night, and does something only in JANUARY: it rolls the previous
 * leave year into the current one for every org that has employees. Nightly
 * rather than once, on purpose: a December leave day entered on 5 January must
 * correct the grant, and the roll is idempotent (`leave-year-roll-service.ts`),
 * so re-running it is how it stays right. By February the year is closed and
 * the tick is a no-op; a later correction is a manual re-run from the summary
 * page.
 *
 * TENANCY. The candidate scan (which orgs have employees) runs on the operator
 * lane, then each org's roll runs inside ITS OWN tenant lane on the normal
 * client, so every grant write stays under RLS. That is the pattern every
 * other worker follows ("borrow the tenant's lane; do not stay privileged").
 *
 * AVAILABILITY. The module is master-silo only; where `HR_MODULE_ENABLED` is
 * unset the tick logs once at debug and returns.
 */

import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { isHrModuleEnabled } from "@/lib/module-flags";
import { runWithTenant } from "@/lib/tenant-context";
import { HR_DEFAULT_TIMEZONE } from "./lib/hr-constants";
import { todayInTimezone, yearOf } from "./lib/hr-date";
import { rollLeaveYear, type YearRollResult } from "./services/leave-year-roll-service";

export interface HrYearRollTickReport {
  ran: boolean;
  reason?: "module-off" | "not-january";
  results: (YearRollResult & { organizationId: string })[];
}

/** Exported for tests; the tick reads the clock through this. */
export function isRollWindow(today: string): boolean {
  return today.slice(5, 7) === "01";
}

export async function runHrYearRollTick(
  now: string = todayInTimezone(HR_DEFAULT_TIMEZONE),
): Promise<HrYearRollTickReport> {
  if (!isHrModuleEnabled()) {
    apiLogger.debug({ msg: "hr/year-roll:module-off" });
    return { ran: false, reason: "module-off", results: [] };
  }
  if (!isRollWindow(now)) {
    return { ran: false, reason: "not-january", results: [] };
  }
  const fromYear = yearOf(now) - 1;

  const orgs = await dbOperator.employee.findMany({
    distinct: ["organizationId"],
    select: { organizationId: true },
  });

  const results: HrYearRollTickReport["results"] = [];
  for (const { organizationId } of orgs) {
    try {
      const result = await runWithTenant(organizationId, () =>
        rollLeaveYear({ organizationId, fromYear, actorUserId: null, source: "cron" }),
      );
      results.push({ organizationId, ...result });
    } catch (err) {
      // One org failing must not stop the others; the next night retries.
      apiLogger.error({ msg: "hr/year-roll:org-failed", err, organizationId, fromYear });
    }
  }
  return { ran: true, results };
}
