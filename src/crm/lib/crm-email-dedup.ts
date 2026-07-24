import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * Persistent, cross-container double-submit guard for a CRM email BLAST
 * (sponsor prospectus / deal email). CRM review M2.
 *
 * The send is synchronous and can fan out to the whole audience (base64
 * attachments, batches of 25). The in-memory rate limiter that used to guard it
 * is per-container, resets on every deploy, and had a 2-minute window — so a
 * gateway-timeout-then-re-click (or a re-click after a blue-green swap) could
 * slip past and re-email everyone. This claims a DB row keyed on the send's
 * (org, content-hash) so an identical send inside CRM_EMAIL_DEDUP_WINDOW_MS is
 * refused, holding across containers and deploys.
 *
 * NOT per-recipient resume: a genuine crash MID-send still can't be resumed by
 * this (the send would have to be re-issued and would be blocked as a dup until
 * the window lapses). That is the deliberate scope of the "persistent enqueue
 * dedup" decision — the realistic double-submit is closed; a full resumable job
 * (like the event bulk-email pipeline) was the heavier alternative not chosen.
 */

/** An identical CRM email send inside this window is suppressed as a duplicate. */
export const CRM_EMAIL_DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** Claims older than this are pruned opportunistically (bounds table growth). */
const PRUNE_AFTER_MS = 60 * 60 * 1000;

/**
 * Atomically claim an email send. Returns true when THIS caller won the claim
 * (proceed with the send), false when an identical send is already recent
 * (refuse with 409). Race-safe: the `@@unique([organizationId, dedupHash])`
 * makes the create the atomic claim, and a P2002 loser only re-takes a STALE
 * claim via a conditional updateMany — two concurrent double-clicks can't both
 * win.
 */
export async function claimCrmEmailSend(
  organizationId: string,
  dedupHash: string,
): Promise<boolean> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - CRM_EMAIL_DEDUP_WINDOW_MS);

  // Opportunistic prune of this org's expired claims — bounds table growth with
  // no worker. Failure here must never block a send (logged, not thrown).
  try {
    await db.crmEmailSendClaim.deleteMany({
      where: { organizationId, claimedAt: { lt: new Date(now.getTime() - PRUNE_AFTER_MS) } },
    });
  } catch (err) {
    apiLogger.warn({
      msg: "crm-email-dedup:prune-failed",
      organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await db.crmEmailSendClaim.create({ data: { organizationId, dedupHash, claimedAt: now } });
    return true; // no prior claim — we won
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    // A claim already exists. Re-take it ONLY if it is stale (outside the
    // window); a fresh claim means an identical send is in-flight/recent.
    const refreshed = await db.crmEmailSendClaim.updateMany({
      where: { organizationId, dedupHash, claimedAt: { lt: staleCutoff } },
      data: { claimedAt: now },
    });
    return refreshed.count === 1;
  }
}
