/**
 * Seeding an org's HR module: the leave-code catalogue and a year of public
 * holidays.
 *
 * SEED ONCE, NEVER RESURRECT. Following `ensurePipelineStages` (the CRM
 * precedent): if the org already has any leave codes, this does nothing. An org
 * that deliberately deleted or renamed a code must not have it reappear on the
 * next page load, which is what a naive per-code upsert would do.
 *
 * Holidays are seeded per YEAR for the same reason, and only for a year that has
 * none. Islamic dates move with the moon, so a year HR has already curated is
 * never overwritten.
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { HR_LEAVE_CODE_SEED, HR_PUBLIC_HOLIDAYS_2026 } from "../lib/hr-seed-data";
import { fromCalendarDate, yearOf } from "../lib/hr-date";

export async function ensureLeaveCodes(organizationId: string): Promise<number> {
  const existing = await db.leaveCode.count({ where: { organizationId } });
  if (existing > 0) return 0;

  const created = await db.leaveCode.createMany({
    data: HR_LEAVE_CODE_SEED.map((c, index) => ({
      organizationId,
      code: c.code,
      label: c.label,
      lawReference: c.lawReference,
      paid: c.paid,
      dayWeight: c.dayWeight,
      countsAs: c.countsAs,
      sortOrder: index,
    })),
    // A concurrent first request would otherwise collide on the unique key.
    skipDuplicates: true,
  });
  apiLogger.info({ msg: "hr-seed:leave-codes-created", organizationId, count: created.count });
  return created.count;
}

export async function ensurePublicHolidays2026(organizationId: string): Promise<number> {
  const year = yearOf(HR_PUBLIC_HOLIDAYS_2026[0].date);
  const existing = await db.publicHoliday.count({
    where: {
      organizationId,
      date: {
        gte: fromCalendarDate(`${year}-01-01`),
        lte: fromCalendarDate(`${year}-12-31`),
      },
    },
  });
  if (existing > 0) return 0;

  const created = await db.publicHoliday.createMany({
    data: HR_PUBLIC_HOLIDAYS_2026.map((h) => ({
      organizationId,
      date: fromCalendarDate(h.date),
      label: h.label,
    })),
    skipDuplicates: true,
  });
  apiLogger.info({ msg: "hr-seed:holidays-created", organizationId, year, count: created.count });
  return created.count;
}
