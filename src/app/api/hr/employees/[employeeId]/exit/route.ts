/**
 * POST /api/hr/employees/[employeeId]/exit — record a leaver.
 *
 * The record is NEVER deleted or hidden. It is the evidence for end-of-service
 * gratuity and leave encashment, and it outlives both the login and the
 * employment. Setting an exit date is what removes the person from the active
 * list and stops attendance being recordable past their last day.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { calendarDateSchema } from "@/hr/lib/hr-date";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { denyNonHr } from "@/hr/lib/hr-roles";
import { setEmployeeExit } from "@/hr/services/employee-service";
import { HTTP_STATUS_FOR_EMPLOYEE_ERROR } from "../../route";

const exitSchema = z.object({
  // The LAST WORKING DAY, inclusive.
  exitDate: calendarDateSchema,
  status: z.enum(["RESIGNED", "TERMINATED"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> },
) {
  const [session, { employeeId }] = await Promise.all([auth(), params]);
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/employee-exit:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/employee-exit", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/employee-exit" });
  if ("error" in org) return org.error;

  const body = await req.json().catch(() => null);
  const parsed = exitSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/employee-exit:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return runWithTenant(org.orgId, async () => {
    const result = await setEmployeeExit({
      organizationId: org.orgId,
      actorUserId: session.user.id,
      employeeId,
      ...parsed.data,
    });
    if (!result.ok) {
      apiLogger.warn({ msg: "hr/employee-exit:rejected", code: result.code, employeeId });
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: HTTP_STATUS_FOR_EMPLOYEE_ERROR[result.code] },
      );
    }
    return NextResponse.json({ employee: result.employee });
  });
}
