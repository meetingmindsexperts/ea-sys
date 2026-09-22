/** Start the QuickBooks connect flow: redirect the settle holder to Intuit's consent screen. */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit } from "@/lib/security";
import { procurementGuard } from "@/procurement/lib/route-helpers";
import { resolveQuickBooksApp } from "@/procurement/integrations/quickbooks/config";
import { buildAuthorizeUrl } from "@/procurement/integrations/quickbooks/oauth";
import { mintConnectState } from "@/procurement/integrations/quickbooks/state";

const ROUTE = "integrations/quickbooks/connect";

export async function GET() {
  const g = await procurementGuard({ route: ROUTE, need: "integration" });
  if (!g.ok) return g.response;

  const rl = checkRateLimit({ key: `quickbooks-connect:${g.user.id}`, limit: 20, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: g.user.id, limit: 20, windowSeconds: 3600 });

  // This handler reads nothing from the database; the lane is here so the whole
  // /api/integrations/quickbooks directory sits inside the tenancy CI gate,
  // which counts one wrap per handler. Phase 3 adds routes here that DO write
  // policied procurement tables, and the gate must already be watching by then.
  return runWithTenant(g.orgId, async () => {
    const app = resolveQuickBooksApp();
    if (!app) {
      apiLogger.warn({ msg: `${ROUTE}:not-configured`, organizationId: g.orgId, userId: g.user.id });
      return NextResponse.json(
        { error: "No QuickBooks app is configured for this deployment", code: "NOT_CONFIGURED" },
        { status: 409 },
      );
    }

    // The state is the ONLY thing tying the callback to this person and this
    // organisation, so it is signed and short-lived (state.ts).
    const state = mintConnectState({ organizationId: g.orgId, userId: g.user.id });
    apiLogger.info({ msg: `${ROUTE}:starting`, organizationId: g.orgId, userId: g.user.id, environment: app.environment });
    return NextResponse.redirect(buildAuthorizeUrl(app, state), { status: 302 });
  });
}
