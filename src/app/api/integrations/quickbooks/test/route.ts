/** Probe the live QuickBooks connection and record the verdict on it. */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit } from "@/lib/security";
import { procurementGuard } from "@/procurement/lib/route-helpers";
import { runHealthCheck } from "@/procurement/integrations/quickbooks/client";

const ROUTE = "integrations/quickbooks/test";

/** A failure's cause decides the status: our configuration, or theirs. */
const STATUS: Record<string, number> = {
  NOT_CONFIGURED: 409,
  NOT_CONNECTED: 409,
  ENVIRONMENT_MISMATCH: 409,
  APP_CHANGED: 409,
  REFRESH_EXPIRED: 409,
  REFRESH_FAILED: 502,
  HTTP_ERROR: 502,
  NETWORK: 502,
  MALFORMED: 502,
};

export async function POST() {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;

  // Its own bucket: this one leaves the building, unlike the read routes.
  const rl = checkRateLimit({ key: `quickbooks-test:${g.user.id}`, limit: 30, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: g.user.id, limit: 30, windowSeconds: 3600 });

  return runWithTenant(g.orgId, async () => {
    const res = await runHealthCheck(g.orgId);
    if (!res.ok) {
      apiLogger.warn({ msg: `${ROUTE}:failed`, organizationId: g.orgId, userId: g.user.id, code: res.code });
      return NextResponse.json({ ok: false, code: res.code, error: res.message }, { status: STATUS[res.code] ?? 502 });
    }
    apiLogger.info({ msg: `${ROUTE}:ok`, organizationId: g.orgId, userId: g.user.id, company: res.data.companyName });
    return NextResponse.json({ ok: true, company: res.data });
  });
}
