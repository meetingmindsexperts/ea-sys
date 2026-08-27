/** PATCH /api/hr/employees/[employeeId] — edit an employee. */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { denyNonHr } from "@/hr/lib/hr-roles";
import { updateEmployee } from "@/hr/services/employee-service";
import { HTTP_STATUS_FOR_EMPLOYEE_ERROR } from "../route";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  department: z.string().max(120).nullish(),
  jobTitle: z.string().max(120).nullish(),
  joiningDate: ISO_DATE.optional(),
  exitDate: ISO_DATE.nullish(),
  carryoverDays: z.number().min(-999).max(999).optional(),
  openingSickUsed: z.number().min(0).max(999).optional(),
  openingCompOff: z.number().min(0).max(999).optional(),
  notes: z.string().max(2000).nullish(),
  status: z.enum(["ACTIVE", "RESIGNED", "TERMINATED"]).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ employeeId: string }> },
) {
  const [session, { employeeId }] = await Promise.all([auth(), params]);
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/employee:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/employee", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/employee" });
  if ("error" in org) return org.error;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/employee:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return runWithTenant(org.orgId, async () => {
    const result = await updateEmployee({
      organizationId: org.orgId,
      actorUserId: session.user.id,
      employeeId,
      patch: parsed.data,
    });
    if (!result.ok) {
      apiLogger.warn({ msg: "hr/employee:update-rejected", code: result.code, employeeId });
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: HTTP_STATUS_FOR_EMPLOYEE_ERROR[result.code] },
      );
    }
    return NextResponse.json({ employee: result.employee });
  });
}
