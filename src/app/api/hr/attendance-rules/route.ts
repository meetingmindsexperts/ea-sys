/**
 * GET  /api/hr/attendance-rules  — the standing rules the grid derives from.
 * POST /api/hr/attendance-rules  — record one.
 *
 * A rule is ONE record that speaks for many days. It writes no attendance rows,
 * so creating and removing one are both reversible and neither can destroy
 * something an operator typed: explicit entries always win, and the days a rule
 * covers were never stored.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { denyNonHr } from "@/hr/lib/hr-roles";
import {
  createAttendanceRule,
  listAttendanceRules,
  type AttendanceRuleErrorCode,
} from "@/hr/services/attendance-rule-service";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const HTTP_STATUS_FOR_RULE_ERROR: Record<AttendanceRuleErrorCode, number> = {
  INVALID_DATE: 400,
  REVERSED_RANGE: 400,
  EMPLOYEE_REQUIRED: 400,
  EMPLOYEE_NOT_FOUND: 404,
  LEAVE_CODE_NOT_FOUND: 400,
  RULE_NOT_FOUND: 404,
  UNKNOWN: 500,
};

const createSchema = z
  .object({
    scope: z.enum(["ORG", "EMPLOYEE"]),
    employeeId: z.string().cuid().nullish(),
    code: z.string().min(1).max(20),
    startDate: ISO_DATE,
    endDate: ISO_DATE.nullish(),
    label: z.string().min(1).max(120),
  })
  // Checked here as well as in the service, so a malformed request is refused
  // before it costs a database round trip. The service keeps its own copy
  // because it is also reachable from a non-HTTP caller.
  .refine((v) => v.scope !== "EMPLOYEE" || !!v.employeeId, {
    message: "A standing arrangement needs a person.",
    path: ["employeeId"],
  });

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/attendance-rules:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/attendance-rules" });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/attendance-rules" });
  if ("error" in org) return org.error;

  const employeeId = req.nextUrl.searchParams.get("employeeId") ?? undefined;

  return runWithTenant(org.orgId, async () => {
    try {
      const rules = await listAttendanceRules({ organizationId: org.orgId, employeeId });
      return NextResponse.json({ rules });
    } catch (err) {
      apiLogger.error({
        msg: "hr/attendance-rules:list-failed",
        err,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Could not load rules." }, { status: 500 });
    }
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/attendance-rules:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/attendance-rules", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/attendance-rules" });
  if ("error" in org) return org.error;

  const rl = checkRateLimit({
    key: `hr-write:${session.user.id}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, {
      route: "hr/attendance-rules",
      userId: session.user.id,
      limit: 300,
      windowSeconds: 3600,
    });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/attendance-rules:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return runWithTenant(org.orgId, async () => {
    const result = await createAttendanceRule({
      organizationId: org.orgId,
      actorUserId: session.user.id,
      source: "ui",
      ...parsed.data,
    });
    if (!result.ok) {
      apiLogger.warn({
        msg: "hr/attendance-rules:create-rejected",
        code: result.code,
        scope: parsed.data.scope,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status: HTTP_STATUS_FOR_RULE_ERROR[result.code] },
      );
    }
    return NextResponse.json({ rule: result.result }, { status: 201 });
  });
}
