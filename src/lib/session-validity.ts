/**
 * Is this session still allowed to continue?
 *
 * Pure decision, no I/O, so the auth callback stays a thin caller: it reads the
 * row, asks this, and either returns `null` (sign out) or applies the refresh.
 * Extracted for the same reason as `planSeatTransition` — the interesting part
 * is the truth table, and a truth table buried inside a NextAuth callback can
 * only be tested by standing up NextAuth.
 *
 * BACKGROUND. Sessions are stateless JWTs (see docs/SESSION_ARCHITECTURE.md),
 * so there is no session row to delete and nothing server-side to revoke. The
 * only lever is the periodic re-validation that already runs every 5 minutes:
 * it re-reads the user and rewrites the token. Until Aug 11 2026 it acted on
 * exactly one of the three answers the database can give.
 */

/** What the caller should do with the token. */
export type SessionDecision =
  | { action: "invalidate"; reason: "user-deleted" | "token-revoked" }
  | { action: "refresh"; role: string };

/** The subset of the user row the decision needs. */
export interface SessionUserRow {
  role: string;
  tokenVersion: number;
}

export function decideSessionValidity(
  /** The re-read user row, or null when it no longer exists. */
  dbUser: SessionUserRow | null,
  /**
   * The version claim carried by the token. `undefined` for tokens minted
   * before the claim existed — treated as 0, which matches the column default,
   * so shipping this does NOT sign the existing population out.
   */
  tokenVersion: number | undefined,
): SessionDecision {
  // The account is gone. This used to fall through and the request carried on
  // with the token's cached role, so deleting an ADMIN left them an ADMIN, and
  // because the 24h window is a ROLLING idle timeout an actively-used session
  // never expired at all.
  if (!dbUser) {
    return { action: "invalidate", reason: "user-deleted" };
  }

  // Explicit revocation: the counter was bumped after this token was minted.
  if (dbUser.tokenVersion !== (tokenVersion ?? 0)) {
    return { action: "invalidate", reason: "token-revoked" };
  }

  return { action: "refresh", role: dbUser.role };
}
