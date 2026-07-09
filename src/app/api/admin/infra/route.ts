/**
 * Infra / Ops snapshot — ADMIN + SUPER_ADMIN only, on-demand.
 *   GET /api/admin/infra          → cached snapshot (60s)
 *   GET /api/admin/infra?refresh=1 → force-refresh (bypass cache)
 *
 * The heavy lifting + 60s cache live in src/lib/infra/aws-ops.ts so repeated
 * refreshes can't run up AWS cost. Read-only; needs the instance-role IAM in
 * docs/INFRA_OPS.md. Every guard logs.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { getInfraSnapshot } from "@/lib/infra/aws-ops";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
      apiLogger.warn({ userId: session.user.id, role }, "infra:forbidden");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Guard against a hammered refresh even though the snapshot is cached 60s.
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `infra:${session.user.id}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id }, "infra:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const force = new URL(req.url).searchParams.get("refresh") === "1";
    const snapshot = await getInfraSnapshot(force);
    return NextResponse.json(snapshot);
  } catch (err) {
    apiLogger.error({ err }, "infra:snapshot-failed");
    return NextResponse.json({ error: "Failed to load infra snapshot" }, { status: 500 });
  }
}
