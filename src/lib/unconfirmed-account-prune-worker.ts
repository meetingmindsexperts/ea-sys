import { Prisma } from "@prisma/client";
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { UNCONFIRMED_ACCOUNT_RETENTION_DAYS } from "@/lib/account-signup";

/**
 * unconfirmed-account-prune: removes accounts made at /signup whose address
 * was never confirmed (Nov 5, 2026; docs/ACCOUNT_CONFIRMATION_PLAN.md phase 2).
 * The confirmation email promises it: "an account that is never confirmed is
 * removed after 30 days". Such an account cannot sign in and holds nothing but
 * a name, an address and a password hash, so keeping it only keeps personal
 * data nobody can use.
 *
 * NARROW ON PURPOSE. A candidate is an account MADE AT /signup
 * (AccountProfile.signedUpAt, the positive marker: portal review, Nov 9, 2026),
 * a registrant without an organisation, never confirmed, created at least 30
 * days ago, owning nothing (no registration, no speaker record, no group it
 * coordinates) and never signed in.
 *
 * On dbOperator, the RLS-exempt maintenance lane: this is a cross-tenant
 * sweep with no lane, and on the platform an ordinary read of the policied
 * Registration and Speaker tables finds nothing, so "owns nothing" would be
 * true of everyone and accounts holding registrations would be deleted. Accounts that existed before sign-up are never considered: they
 * were made by registration forms and invitations, and deleting people is not
 * something to start doing to them as a side effect.
 *
 * The database is the last guard: a User row that anything still points at
 * with a restricting key (an issued certificate, a media file, ...) refuses
 * the delete, which is logged and skipped, never forced.
 */

/** The day /signup shipped; accounts made before it are never pruned. */
export const SIGNUP_LAUNCHED_AT = new Date("2026-11-05T00:00:00Z");

/** Per tick; a backlog drains over the following days. */
const MAX_PER_TICK = 200;

export async function runUnconfirmedAccountPruneTick(now: Date = new Date()): Promise<{ deleted: number; skipped: number }> {
  const cutoff = new Date(now.getTime() - UNCONFIRMED_ACCOUNT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await dbOperator.user.findMany({
    where: {
      accountProfile: { signedUpAt: { not: null } },
      role: "REGISTRANT",
      organizationId: null,
      emailConfirmedAt: null,
      createdAt: { gte: SIGNUP_LAUNCHED_AT, lt: cutoff },
      registrations: { none: {} },
      speakers: { none: {} },
      coordinatedGroups: { none: {} },
      loginEvents: { none: { outcome: "SUCCESS" } },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: MAX_PER_TICK,
  });

  let deleted = 0;
  let skipped = 0;
  for (const { id } of candidates) {
    try {
      await dbOperator.user.delete({ where: { id } });
      deleted += 1;
    } catch (err) {
      // Something still points at the account: keep it, say so, move on.
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2014")) {
        skipped += 1;
        apiLogger.warn({ msg: "unconfirmed-account-prune:still-referenced", userId: id, code: err.code });
        continue;
      }
      throw err;
    }
  }

  if (deleted > 0 || skipped > 0) {
    apiLogger.info({
      msg: "unconfirmed-account-prune:tick",
      deleted,
      skipped,
      capped: candidates.length === MAX_PER_TICK,
      cutoff: cutoff.toISOString(),
    });
  }
  return { deleted, skipped };
}
