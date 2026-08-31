/**
 * GET  /api/hr/employees  — the employee list.
 * POST /api/hr/employees  — create one.
 *
 * Every HR route follows the same four steps in the same order: authenticate,
 * `denyNonHr` (which also 404s where the module is switched off), resolve the
 * org, then run inside that org's tenant lane. The lane is inert on master and
 * load-bearing on the platform, so a dropped wrap is silent here and only
 * surfaces the day RLS is enabled. `scripts/check-tenant-als.sh` is what stops
 * that.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { denyNonHr } from "@/hr/lib/hr-roles";
import {
  EMPLOYEE_SELECT,
  createEmployee,
  employedOnWhere,
  toEmployeeView,
  type EmployeeErrorCode,
} from "@/hr/services/employee-service";
import { todayInTimezone } from "@/hr/lib/hr-date";
import { HR_DEFAULT_TIMEZONE } from "@/hr/lib/hr-constants";
import { ensureLeaveCodes, ensurePublicHolidays2026 } from "@/hr/services/hr-seed-service";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const createSchema = z.object({
  empCode: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  department: z.string().max(120).nullish(),
  jobTitle: z.string().max(120).nullish(),
  joiningDate: ISO_DATE,
  exitDate: ISO_DATE.nullish(),
  carryoverDays: z.number().min(-999).max(999).optional(),
  openingSickUsed: z.number().min(0).max(999).optional(),
  openingCompOff: z.number().min(0).max(999).optional(),
  // nullable, not just optional: null CLEARS the agreement and restores the rule.
  annualEntitlementDays: z.number().min(0).max(365).nullish(),
  userId: z.string().cuid().nullish(),
  notes: z.string().max(2000).nullish(),
  // Honoured by the service (a historical leaver in one call); it used to be
  // accepted here and silently dropped there.
  status: z.enum(["ACTIVE", "RESIGNED", "TERMINATED"]).optional(),
});

/** One place mapping service codes to HTTP, so two routes cannot disagree. */
export const HTTP_STATUS_FOR_EMPLOYEE_ERROR: Record<EmployeeErrorCode, number> = {
  INVALID_DATE: 400,
  EXIT_BEFORE_JOINING: 400,
  EXIT_DATE_REQUIRED: 400,
  LEAVER_STATUS_REQUIRED: 400,
  ENTRIES_OUTSIDE_WINDOW: 409,
  EMP_CODE_TAKEN: 409,
  EMPLOYEE_NOT_FOUND: 404,
  USER_ALREADY_LINKED: 409,
  UNKNOWN: 500,
};

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/employees:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/employees" });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/employees" });
  if ("error" in org) return org.error;

  const includeExited = req.nextUrl.searchParams.get("includeExited") === "true";

  return runWithTenant(org.orgId, async () => {
    try {
      // Seeding is idempotent and only fires on an org that has none, so the
      // first person to open the module gets a working catalogue without an
      // operator having to run anything.
      await ensureLeaveCodes(org.orgId);
      await ensurePublicHolidays2026(org.orgId);

      // "Currently employed" is decided by the last working day, not by the
      // status column: see `employedOnWhere`.
      const rows = await db.employee.findMany({
        where: {
          organizationId: org.orgId,
          ...(includeExited ? {} : employedOnWhere(todayInTimezone(HR_DEFAULT_TIMEZONE))),
        },
        select: EMPLOYEE_SELECT,
        orderBy: { empCode: "asc" },
      });
      return NextResponse.json({ employees: rows.map(toEmployeeView) });
    } catch (err) {
      apiLogger.error({ msg: "hr/employees:list-failed", err, userId: session.user.id });
      return NextResponse.json({ error: "Could not load employees." }, { status: 500 });
    }
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/employees:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/employees", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/employees" });
  if ("error" in org) return org.error;

  const rl = checkRateLimit({
    key: `hr-write:${session.user.id}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "hr/employees", userId: session.user.id, limit: 300, windowSeconds: 3600 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/employees:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return runWithTenant(org.orgId, async () => {
    const result = await createEmployee({
      organizationId: org.orgId,
      actorUserId: session.user.id,
      source: "ui",
      ...parsed.data,
    });
    if (!result.ok) {
      apiLogger.warn({
        msg: "hr/employees:create-rejected",
        code: result.code,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: HTTP_STATUS_FOR_EMPLOYEE_ERROR[result.code] },
      );
    }
    return NextResponse.json({ employee: result.employee }, { status: 201 });
  });
}
