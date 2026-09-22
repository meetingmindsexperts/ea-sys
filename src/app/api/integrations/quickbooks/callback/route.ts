/**
 * Where Intuit sends the browser back: swap the code for tokens and store
 * them against the organisation the signed state names.
 *
 * Every exit is a redirect to Settings with a reason, because this is a
 * top-level browser navigation: a JSON error would leave the person looking
 * at a raw payload with no way back.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { procurementGuard } from "@/procurement/lib/route-helpers";
import { loadQuickBooksApp } from "@/procurement/integrations/quickbooks/app";
import { storeNewConnection } from "@/procurement/integrations/quickbooks/connection";
import { exchangeCode } from "@/procurement/integrations/quickbooks/oauth";
import { verifyConnectState } from "@/procurement/integrations/quickbooks/state";
import { runHealthCheck } from "@/procurement/integrations/quickbooks/client";

const ROUTE = "integrations/quickbooks/callback";

function back(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/settings", req.url);
  url.searchParams.set("tab", "integrations");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, { status: 302 });
}

export async function GET(req: NextRequest) {
  const g = await procurementGuard({ route: ROUTE, need: "integration" });
  if (!g.ok) {
    // The guard has already logged who and why; this turns it into a page.
    return back(req, { quickbooks: "error", reason: "forbidden" });
  }

  return runWithTenant(g.orgId, async () => {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    if (error) {
      apiLogger.warn({ msg: `${ROUTE}:intuit-error`, organizationId: g.orgId, userId: g.user.id, error });
      return back(req, { quickbooks: "error", reason: error === "access_denied" ? "declined" : "intuit_error" });
    }

    const code = url.searchParams.get("code");
    const realmId = url.searchParams.get("realmId");
    const state = url.searchParams.get("state");
    if (!code || !realmId || !state) {
      apiLogger.warn({ msg: `${ROUTE}:missing-params`, organizationId: g.orgId, hasCode: !!code, hasRealm: !!realmId, hasState: !!state });
      return back(req, { quickbooks: "error", reason: "missing_params" });
    }

    const verdict = verifyConnectState(state);
    if (!verdict.ok) {
      apiLogger.warn({ msg: `${ROUTE}:bad-state`, organizationId: g.orgId, userId: g.user.id, reason: verdict.reason });
      return back(req, { quickbooks: "error", reason: verdict.reason === "expired" ? "state_expired" : "state_invalid" });
    }
    // The state names the organisation that started this. A signed-in admin of
    // ANOTHER organisation finishing someone else's flow would otherwise attach
    // a QuickBooks company to the wrong tenant.
    if (verdict.organizationId !== g.orgId) {
      apiLogger.error({ msg: `${ROUTE}:state-org-mismatch`, sessionOrg: g.orgId, stateOrg: verdict.organizationId, userId: g.user.id });
      return back(req, { quickbooks: "error", reason: "state_invalid" });
    }

    const app = await loadQuickBooksApp(g.orgId);
    if (!app) {
      apiLogger.error({ msg: `${ROUTE}:not-configured`, organizationId: g.orgId });
      return back(req, { quickbooks: "error", reason: "not_configured" });
    }

    const exchanged = await exchangeCode(app, code);
    if (!exchanged.ok) {
      apiLogger.error({ msg: `${ROUTE}:exchange-failed`, organizationId: g.orgId, userId: g.user.id, code: exchanged.code });
      return back(req, { quickbooks: "error", reason: "exchange_failed" });
    }

    await storeNewConnection({
      organizationId: g.orgId,
      realmId,
      environment: app.environment,
      clientId: app.clientId,
      userId: g.user.id,
      accessToken: exchanged.tokens.accessToken,
      refreshToken: exchanged.tokens.refreshToken,
      accessTokenExpiresAt: exchanged.tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: exchanged.tokens.refreshTokenExpiresAt,
    });
    apiLogger.info({ msg: `${ROUTE}:connected`, organizationId: g.orgId, userId: g.user.id, realmId, environment: app.environment });

    // Name the company straight away, so the card says which QuickBooks file is
    // attached rather than a bare realm id. Failure-isolated: the connection is
    // stored either way and the health job will fill it in.
    const health = await runHealthCheck(g.orgId).catch(() => null);
    return back(req, { quickbooks: "connected", ...(health?.ok && health.data.companyName ? { company: health.data.companyName } : {}) });
  });
}
