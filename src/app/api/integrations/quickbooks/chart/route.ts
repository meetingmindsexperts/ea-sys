/**
 * The two lists the budget module maps onto: QuickBooks Classes (an event
 * code is a Class) and the chart of accounts. Read-only, live from
 * QuickBooks, nothing stored.
 */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit } from "@/lib/security";
import { procurementGuard } from "@/procurement/lib/route-helpers";
import { listAccounts, listClasses } from "@/procurement/integrations/quickbooks/client";

const ROUTE = "integrations/quickbooks/chart";

const STATUS: Record<string, number> = {
  NOT_CONFIGURED: 409,
  NOT_CONNECTED: 409,
  ENVIRONMENT_MISMATCH: 409,
  REFRESH_EXPIRED: 409,
  REFRESH_FAILED: 502,
  HTTP_ERROR: 502,
  NETWORK: 502,
  MALFORMED: 502,
};

export async function GET() {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;

  const rl = checkRateLimit({ key: `quickbooks-chart:${g.user.id}`, limit: 60, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: g.user.id, limit: 60, windowSeconds: 3600 });

  return runWithTenant(g.orgId, async () => {
    // Sequential, not parallel: the second call reuses the token the first
    // refreshed, so running them together would refresh twice and rotate the
    // refresh token under itself.
    const classes = await listClasses(g.orgId);
    if (!classes.ok) {
      apiLogger.warn({ msg: `${ROUTE}:classes-failed`, organizationId: g.orgId, userId: g.user.id, code: classes.code });
      return NextResponse.json({ error: classes.message, code: classes.code }, { status: STATUS[classes.code] ?? 502 });
    }
    const accounts = await listAccounts(g.orgId);
    if (!accounts.ok) {
      apiLogger.warn({ msg: `${ROUTE}:accounts-failed`, organizationId: g.orgId, userId: g.user.id, code: accounts.code });
      return NextResponse.json({ error: accounts.message, code: accounts.code }, { status: STATUS[accounts.code] ?? 502 });
    }

    return NextResponse.json({
      classes: classes.data,
      accounts: accounts.data,
      counts: { classes: classes.data.length, accounts: accounts.data.length },
    });
  });
}
