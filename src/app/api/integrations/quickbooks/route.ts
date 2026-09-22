/** GET the organisation's QuickBooks connection (no secrets, no network); DELETE disconnects it. */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { decryptSecret } from "@/lib/eventsair-client";
import { procurementGuard } from "@/procurement/lib/route-helpers";
import { resolveQuickBooksApp } from "@/procurement/integrations/quickbooks/config";
import { clearConnection, loadConnection, toStatus } from "@/procurement/integrations/quickbooks/connection";
import { revokeToken } from "@/procurement/integrations/quickbooks/oauth";

const ROUTE = "integrations/quickbooks";

export async function GET() {
  const g = await procurementGuard({ route: ROUTE, need: "view" });
  if (!g.ok) return g.response;

  return runWithTenant(g.orgId, async () => {
    const app = resolveQuickBooksApp();
    const connection = await loadConnection(g.orgId);
    return NextResponse.json({
      // Whether this DEPLOYMENT has an Intuit app at all; without one the card
      // shows what to set rather than a Connect button that cannot work.
      configured: !!app,
      environment: app?.environment ?? null,
      redirectUri: app?.redirectUri ?? null,
      connection: toStatus(connection, app),
    });
  });
}

export async function DELETE() {
  const g = await procurementGuard({ route: ROUTE, need: "settle", write: true });
  if (!g.ok) return g.response;

  return runWithTenant(g.orgId, async () => {
    const app = resolveQuickBooksApp();
    const connection = await loadConnection(g.orgId);
    if (!connection) {
      apiLogger.warn({ msg: `${ROUTE}:disconnect-not-connected`, organizationId: g.orgId, userId: g.user.id });
      return NextResponse.json({ error: "Not connected to QuickBooks", code: "NOT_CONNECTED" }, { status: 409 });
    }

    // Revocation is best-effort: our side must be removable even when Intuit
    // is unreachable, or a broken connection could never be replaced.
    let revoked = false;
    if (app) {
      try {
        revoked = await revokeToken(app, decryptSecret(connection.refreshTokenEncrypted));
      } catch (err) {
        apiLogger.warn({ msg: `${ROUTE}:revoke-threw`, organizationId: g.orgId, err: err instanceof Error ? err.message : String(err) });
      }
    }

    await clearConnection(g.orgId);
    apiLogger.info({ msg: `${ROUTE}:disconnected`, organizationId: g.orgId, userId: g.user.id, realmId: connection.realmId, revoked });
    return NextResponse.json({ disconnected: true, revoked });
  });
}
