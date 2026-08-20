/**
 * nginx traffic snapshot for the /admin/infra Traffic card.
 *   GET /api/admin/infra/traffic
 *
 * Served OUTSIDE the main /api/admin/infra snapshot on purpose. Two reasons:
 * the payload is hundreds of hourly buckets and would bloat every poll of a
 * page that already carries a lot; and it refreshes hourly, not every 60
 * seconds, so sharing that cache would be misleading in both directions.
 *
 * PLATFORM OPERATOR ONLY. nginx has no idea which tenant a request belonged to,
 * so these totals span every organisation on the instance. A tenant's own ADMIN
 * seeing them would learn how busy their neighbours are. This follows the same
 * rule the recent-errors panel already applies, and it is stated out loud in
 * the response rather than returned as an empty card, because an empty traffic
 * chart reads as "no traffic" and that is the wrong thing to tell someone.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { canActAsPlatformOperator } from "@/lib/platform-operator";
import { fetchNginxTraffic } from "@/lib/infra/nginx-traffic";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
      apiLogger.warn({ userId: session.user.id, role }, "infra-traffic:forbidden");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!canActAsPlatformOperator(session.user)) {
      // Not an error and not a 403: the card exists, this audience may not see
      // it. Rendering the reason keeps the page honest.
      return NextResponse.json({ status: "operator-only", info: null });
    }

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `infra-traffic:${session.user.id}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: session.user.id }, "infra-traffic:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const traffic = await fetchNginxTraffic();
    return NextResponse.json(traffic);
  } catch (err) {
    apiLogger.error({ err }, "infra-traffic:failed");
    return NextResponse.json({ error: "Failed to load traffic snapshot" }, { status: 500 });
  }
}
