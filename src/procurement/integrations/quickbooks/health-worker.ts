/**
 * The daily QuickBooks health sweep (September 22, 2026).
 *
 * A QuickBooks connection dies quietly: a refresh token unused for about
 * 100 days simply stops working, and nothing tells us. Without a daily
 * probe the first sign would be a purchase order failing to post, which in
 * Phase 3 is money-adjacent. The sweep touches the connection every day, so
 * the token stays warm AND the card carries a last-good timestamp.
 *
 * Org-blind by design at the scan (which organisations have a connection is
 * exactly what it is looking for); every probe then runs against one
 * organisation's own stored tokens.
 */
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { readConnection } from "./connection";
import { runHealthCheck } from "./client";
import { isProcurementModuleEnabled } from "@/lib/module-flags";

export interface QuickBooksHealthSummary {
  checked: number;
  ok: number;
  failed: number;
}

export async function runQuickBooksHealthTick(): Promise<QuickBooksHealthSummary> {
  const summary: QuickBooksHealthSummary = { checked: 0, ok: 0, failed: 0 };

  // Nothing to do with the module switched off; a no-op tick rather than an
  // error, like every other gated job. There is deliberately no second gate on
  // "does a QuickBooks app exist": the app is per organisation now, so that
  // question is only answerable per row, and an organisation holding a
  // connection with no app is a real fault the probe should surface rather
  // than a reason to skip the sweep.
  if (!isProcurementModuleEnabled()) return summary;

  const orgs = await dbOperator.organization.findMany({ select: { id: true, settings: true } });
  for (const org of orgs) {
    if (!readConnection(org.settings)) continue;
    summary.checked++;
    try {
      // The scan is privileged (which organisations have a connection is what it
      // is looking for); the work is not. Borrow the tenant's own lane.
      const res = await runWithTenant(org.id, () => runHealthCheck(org.id));
      if (res.ok) {
        summary.ok++;
      } else {
        summary.failed++;
        apiLogger.warn({ msg: "quickbooks-health:check-failed", organizationId: org.id, code: res.code, error: res.message });
      }
    } catch (err) {
      // A throw here must not stop the other organisations' checks.
      summary.failed++;
      apiLogger.error({ msg: "quickbooks-health:check-threw", organizationId: org.id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  if (summary.checked > 0) {
    apiLogger.info({ msg: "quickbooks-health:tick", ...summary });
  }
  return summary;
}
