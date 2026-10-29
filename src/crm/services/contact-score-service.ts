/**
 * The stored contact score: kept current for the paged list's sort (Oct 29,
 * 2026). SERVER ONLY.
 *
 * CrmContact.score exists only so the database can ORDER the contacts list by
 * score; every screen still shows the score computed live by
 * computeContactScore (src/crm/lib/contact-score.ts). So a stale stored score
 * can only misplace a row in the "Score" sort, never show a wrong number.
 *
 * Kept current two ways:
 *  1. refreshContactScores() after every write that changes a contact's
 *     deals: a stage move or close (status), archive / restore, a person added
 *     to or removed from a deal, an import that updates deals. (A purge needs
 *     none: it deletes only archived deals, which never count.)
 *  2. The nightly crm-contact-score worker job recomputes the whole book and
 *     logs how many rows it had to fix: a non-zero count means a write path
 *     above was missed.
 *
 * Raw SQL on purpose: a Prisma update would bump updatedAt, and the Freshsales
 * import reads updatedAt as "edited locally" (crm-import-service.ts).
 *
 * Tenancy: raw SQL is NOT wrapped by the db client's tenant extension, so
 * every statement here runs in tenantTransaction() inside that organisation's
 * lane (review MED, Oct 29, 2026); under RLS a raw query outside it would see
 * no rows and "repair" nothing while reporting zero.
 *
 * Never throws: the write that triggered it has already committed, so a
 * failure is logged and left for the nightly repair.
 */
import { Prisma } from "@prisma/client";
import { tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import {
  EXTRA_OPEN_DEAL_POINTS,
  FIRST_OPEN_DEAL_POINTS,
  MAX_SCORE,
  OPEN_DEAL_CAP,
  WON_DEAL_POINTS,
} from "@/crm/lib/contact-score";

/** Ids per statement: far under Postgres's bind-parameter limit on a large import. */
const ID_CHUNK = 1000;

/** The SQL twin of computeContactScore, over one contact's deal links. */
const SCORE_SQL = Prisma.sql`
  LEAST(
    ${MAX_SCORE},
    (CASE
      WHEN COUNT(*) FILTER (WHERE d.status = 'OPEN' AND d."archivedAt" IS NULL) = 0 THEN 0
      ELSE LEAST(
        ${OPEN_DEAL_CAP},
        ${FIRST_OPEN_DEAL_POINTS} + ${EXTRA_OPEN_DEAL_POINTS} * (COUNT(*) FILTER (WHERE d.status = 'OPEN' AND d."archivedAt" IS NULL) - 1)
      )
    END)
    + (CASE WHEN COUNT(*) FILTER (WHERE d.status = 'WON' AND d."archivedAt" IS NULL) > 0 THEN ${WON_DEAL_POINTS} ELSE 0 END)
  )::INTEGER`;

/** Run raw SQL in the organisation's tenant lane (see the header). */
function inOrgLane<T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return runWithTenant(organizationId, () => tenantTransaction(fn));
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK));
  return out;
}

/** Recompute the stored scores in one organisation, narrowed by `scope`. Returns how many changed. */
function recompute(tx: Prisma.TransactionClient, organizationId: string, scope: Prisma.Sql): Promise<number> {
  return tx.$executeRaw`
    UPDATE "CrmContact" c
    SET "score" = s.score
    FROM (
      SELECT c2.id, ${SCORE_SQL} AS score
      FROM "CrmContact" c2
      LEFT JOIN "CrmDealContact" dc ON dc."crmContactId" = c2.id
      LEFT JOIN "CrmDeal" d ON d.id = dc."dealId"
      WHERE c2."organizationId" = ${organizationId} AND ${scope}
      GROUP BY c2.id
    ) s
    WHERE c.id = s.id AND c."score" IS DISTINCT FROM s.score`;
}

/** After a write that changed these contacts' deals. Never throws. */
export async function refreshContactScores(organizationId: string, crmContactIds: string[]): Promise<void> {
  const ids = [...new Set(crmContactIds)];
  if (ids.length === 0) return;
  try {
    await inOrgLane(organizationId, async (tx) => {
      for (const part of chunks(ids)) await recompute(tx, organizationId, Prisma.sql`c2.id IN (${Prisma.join(part)})`);
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm-contact-score:refresh-failed",
      organizationId,
      contactCount: ids.length,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** After a write to a deal's status or archive state: every contact on it. Never throws. */
export async function refreshScoresForDeal(organizationId: string, dealId: string): Promise<void> {
  await refreshScoresForDeals(organizationId, [dealId]);
}

/** The same for many deals at once (an import). Never throws. */
export async function refreshScoresForDeals(organizationId: string, dealIds: string[]): Promise<void> {
  const ids = [...new Set(dealIds)];
  if (ids.length === 0) return;
  try {
    await inOrgLane(organizationId, async (tx) => {
      for (const part of chunks(ids)) {
        await recompute(
          tx,
          organizationId,
          Prisma.sql`c2.id IN (
            SELECT "crmContactId" FROM "CrmDealContact"
            WHERE "organizationId" = ${organizationId} AND "dealId" IN (${Prisma.join(part)})
          )`,
        );
      }
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm-contact-score:refresh-failed",
      organizationId,
      dealCount: ids.length,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The nightly repair for one organisation (contact-score-worker.ts). Returns
 * how many rows were wrong, which the job logs: non-zero means a write path
 * above was missed. Throws, so the worker can count a failed organisation.
 */
export function repairContactScores(organizationId: string): Promise<number> {
  return inOrgLane(organizationId, (tx) => recompute(tx, organizationId, Prisma.sql`TRUE`));
}
