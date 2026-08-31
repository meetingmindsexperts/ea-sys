/**
 * POST /api/hr/leave-year/roll — carry one leave year's closing balances into
 * the next, on demand.
 *
 * The worker does this every night through January. This route is the manual
 * re-run for a correction made later (a December entry fixed in March), and
 * it is safe to press twice: the roll is an upsert that recomputes from the
 * rows, so it can only ever make the grant right.
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
import { rollLeaveYear } from "@/hr/services/leave-year-roll-service";

const schema = z.object({
  /** The year being CLOSED; the grant is written for the year after it. */
  fromYear: z.number().int().min(2000).max(2100),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "hr/leave-year-roll:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyNonHr(session, { route: "hr/leave-year-roll", write: true });
  if (denied) return denied;
  const org = requireOrgId(session, { route: "hr/leave-year-roll" });
  if ("error" in org) return org.error;

  const rl = checkRateLimit({
    key: `hr-write:${session.user.id}`,
    limit: 300,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "hr/leave-year-roll", userId: session.user.id, limit: 300, windowSeconds: 3600 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "hr/leave-year-roll:zod-validation-failed",
      errors: parsed.error.flatten(),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return runWithTenant(org.orgId, async () => {
    try {
      const result = await rollLeaveYear({
        organizationId: org.orgId,
        fromYear: parsed.data.fromYear,
        actorUserId: session.user.id,
        source: "ui",
      });
      return NextResponse.json({ result });
    } catch (err) {
      apiLogger.error({
        msg: "hr/leave-year-roll:failed",
        err,
        fromYear: parsed.data.fromYear,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Could not roll the leave year." }, { status: 500 });
    }
  });
}
