/**
 * The nightly repair of the stored contact score (Oct 29, 2026), as a worker
 * tick. See src/crm/services/contact-score-service.ts for why the score is
 * stored and how it is kept current.
 *
 * Every write that changes a contact's deals refreshes the score right away;
 * this pass recomputes every organisation's book and reports how many rows it
 * had to fix. A non-zero count means some write path was missed, so it is
 * logged at warn (the fix itself is already done).
 *
 * TENANCY. The candidate scan (which orgs have CRM contacts) runs on the
 * operator lane; each org's repair runs inside ITS OWN tenant lane on the
 * normal client, so the writes stay under RLS (the hr-year-roll pattern).
 */
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { repairContactScores } from "./services/contact-score-service";

export interface ContactScoreTickReport {
  organizations: number;
  fixed: number;
  failed: number;
}

export async function runContactScoreTick(): Promise<ContactScoreTickReport> {
  const orgs = await dbOperator.crmContact.findMany({
    distinct: ["organizationId"],
    select: { organizationId: true },
  });

  const report: ContactScoreTickReport = { organizations: orgs.length, fixed: 0, failed: 0 };
  for (const { organizationId } of orgs) {
    try {
      const fixed = await runWithTenant(organizationId, () => repairContactScores(organizationId));
      report.fixed += fixed;
      if (fixed > 0) apiLogger.warn({ msg: "crm-contact-score:repaired-stale", organizationId, fixed });
    } catch (err) {
      report.failed++;
      apiLogger.error({
        msg: "crm-contact-score:repair-failed",
        organizationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  apiLogger.info({ msg: "crm-contact-score:tick-done", ...report });
  return report;
}
