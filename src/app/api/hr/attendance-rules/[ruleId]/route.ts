/**
 * DELETE /api/hr/attendance-rules/[ruleId] — end a standing rule.
 *
 * Safe as a hard delete BECAUSE the rule stored no attendance rows. The days it
 * was covering simply go back to being derived, which is what they always were.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { denyNonHr } from "@/hr/lib/hr-roles";
import { deleteAttendanceRule } from "@/hr/services/attendance-rule-service";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ ruleId: string }> },
) {
  const [session, { ruleId }] = await Promise.all([auth(), params]);
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/attendance-rules:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/attendance-rules:DELETE", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/attendance-rules:DELETE" });
  if ("error" in org) return org.error;

  const rl = checkRateLimit({
    key: `hr-write:${session.user.id}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, {
      route: "hr/attendance-rules:DELETE",
      userId: session.user.id,
      limit: 300,
      windowSeconds: 3600,
    });
  }

  return runWithTenant(org.orgId, async () => {
    const result = await deleteAttendanceRule({
      organizationId: org.orgId,
      actorUserId: session.user.id,
      ruleId,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: result.code === "RULE_NOT_FOUND" ? 404 : 500 },
      );
    }
    return NextResponse.json({ ok: true });
  });
}
