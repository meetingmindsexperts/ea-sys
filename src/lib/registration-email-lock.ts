import type { Prisma } from "@prisma/client";

/**
 * Serialize registration creates for the same person on the same event
 * (Oct 29, 2026). Nothing in the database stops two rows for one email: the
 * only email unique, on Attendee, was dropped on Mar 30, 2026 (migration
 * 20260330300000), and transactions run at READ COMMITTED, so two concurrent
 * creates both read "no registration" and both commit. Every creation path
 * takes this lock as the first statement of its transaction and checks for a
 * duplicate after it; the second request then waits, sees the first one's
 * row, and refuses.
 *
 * A transaction-scoped advisory lock (the webinar-sequence and procurement
 * pattern): released at commit or rollback, so it is safe behind the pooler,
 * and it only serializes requests for the same email on the same event.
 * Emails are lowercased (one person, whatever the case) and locked in sorted
 * order of the lock key's hash, so two transactions locking several emails
 * cannot deadlock. The duplicate check behind the lock must be
 * case-insensitive too (`mode: "insensitive"`). A hash
 * collision only makes two unrelated people wait for each other briefly.
 */
export async function lockRegistrationEmails(
  tx: Prisma.TransactionClient,
  eventId: string,
  emails: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const keys = [...new Set(emails.map((e) => e?.trim().toLowerCase()).filter((e): e is string => !!e))]
    .map((email) => registrationEmailLockKey(eventId, email))
    .sort();
  if (keys.length === 0) return;
  if (keys.length === 1) {
    // ::text because pg_advisory_xact_lock returns void, which $queryRaw cannot read.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${keys[0]}))::text`;
    return;
  }
  // A batch (import, group) in one round trip. Ordered by the HASH, which is
  // what is actually locked: ordering by the key text would let two batches
  // whose keys collide take the same two locks in opposite orders (review of
  // f74b2017, L2). DISTINCT folds a collision into one lock.
  await tx.$queryRaw`
    SELECT count(*)::text FROM (
      SELECT pg_advisory_xact_lock(h) FROM (SELECT DISTINCT hashtext(k) AS h FROM unnest(${keys}::text[]) AS k ORDER BY h) ordered
    ) locked`;
}

export function registrationEmailLockKey(eventId: string, email: string): string {
  return `registration:${eventId}:${email.trim().toLowerCase()}`;
}
