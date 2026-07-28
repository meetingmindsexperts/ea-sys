/**
 * Failed-sign-in throttle.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `/api/auth/mobile-login` has always been rate limited (10 attempts / 15 min
 * per IP). The NextAuth credentials path — which every dashboard login and
 * every event-scoped login goes through — had NO limit at all, so passwords
 * could be brute-forced against production unthrottled.
 *
 * WHY NOT `checkRateLimit`
 * -----------------------
 * The shared helper consumes a token on every call, which is right for "N
 * requests per window" but wrong for a login throttle in two ways:
 *
 *   1. It would count SUCCESSES. At a conference, hundreds of attendees sign in
 *      from one venue-WiFi NAT address; burning the budget on people who typed
 *      their password correctly would lock out the venue. Only failures should
 *      cost anything.
 *   2. It has no reset. A user who mistypes twice and then succeeds should be
 *      back to a clean slate, not two failures closer to a lockout.
 *
 * Rather than add a `consume: false` flag to a helper used at ~105 call sites
 * to serve one caller, this is its own small primitive with the semantics the
 * problem actually has: peek before the attempt, charge only on failure, clear
 * on success.
 *
 * TWO BUCKETS, VERY DIFFERENT LIMITS
 * ----------------------------------
 * Per-EMAIL is the real protection and is tight: a legitimate person does not
 * fail ten times in a quarter of an hour, while an attacker guessing one
 * account's password does nothing else. It also catches the distributed case,
 * where attempts come from many IPs at one address.
 *
 * Per-IP is deliberately loose. Its job is to stop a single host spraying
 * thousands of attempts, not to police a shared address — see the NAT problem
 * above. A hundred failures in fifteen minutes is far beyond what a room full
 * of people mistyping produces, and far below what automated spray produces.
 *
 * A success clears the EMAIL bucket only. Clearing the IP bucket too would let
 * an attacker who holds one valid account reset the spray counter at will.
 *
 * STORE
 * -----
 * In-memory, per container, same as `checkRateLimit` — counters reset on
 * deploy/restart, and two containers each keep their own tally. Accepted for
 * the same reason it is accepted there: it raises the cost of brute force by
 * orders of magnitude without a Redis dependency. Migrating both to a shared
 * store is tracked as the same piece of work.
 */

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/** A real person does not fail this many times in fifteen minutes. */
export const EMAIL_FAILURE_LIMIT = 10;

/** Loose on purpose — a shared venue IP must not lock its whole room out. */
export const IP_FAILURE_LIMIT = 100;

export const FAILURE_WINDOW_MS = FIFTEEN_MINUTES_MS;

interface FailureBucket {
  count: number;
  resetAt: number;
}

/**
 * Held on globalThis so Next's dev-mode module reloading doesn't hand out a
 * fresh empty map on every edit — mirroring how the rate-limit store is kept.
 */
const globalForThrottle = globalThis as unknown as {
  loginFailureStore?: Map<string, FailureBucket>;
};

function getStore(): Map<string, FailureBucket> {
  if (!globalForThrottle.loginFailureStore) {
    globalForThrottle.loginFailureStore = new Map();
  }
  return globalForThrottle.loginFailureStore;
}

function emailKey(email: string): string {
  return `login-fail:email:${email.trim().toLowerCase()}`;
}

function ipKey(ip: string): string {
  return `login-fail:ip:${ip}`;
}

/**
 * Read a bucket without charging it. Expired buckets are treated as empty AND
 * dropped, so the map doesn't accumulate dead keys from one-off typos.
 */
function peek(key: string, limit: number): { blocked: boolean; retryAfterSeconds: number } {
  const store = getStore();
  const bucket = store.get(key);
  const now = Date.now();

  if (!bucket || bucket.resetAt <= now) {
    if (bucket) store.delete(key);
    return { blocked: false, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return {
      blocked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  return { blocked: false, retryAfterSeconds: 0 };
}

/**
 * Is this attempt currently locked out? Call BEFORE checking the password —
 * that way a flood never reaches bcrypt (which is intentionally expensive) or
 * the database.
 *
 * Charges nothing. Blocked when EITHER bucket is over its limit; the reported
 * wait is the longer of the two, so a caller never tells someone to come back
 * sooner than they actually can.
 */
export function isLoginBlocked(
  email: string,
  ip: string,
): { blocked: boolean; retryAfterSeconds: number; reason: "email" | "ip" | null } {
  const byEmail = peek(emailKey(email), EMAIL_FAILURE_LIMIT);
  const byIp = ip && ip !== "unknown" ? peek(ipKey(ip), IP_FAILURE_LIMIT) : { blocked: false, retryAfterSeconds: 0 };

  if (!byEmail.blocked && !byIp.blocked) {
    return { blocked: false, retryAfterSeconds: 0, reason: null };
  }

  return {
    blocked: true,
    retryAfterSeconds: Math.max(byEmail.retryAfterSeconds, byIp.retryAfterSeconds),
    // Name the tighter bucket when both tripped — it's the more specific signal.
    reason: byEmail.blocked ? "email" : "ip",
  };
}

/** Charge one failure against both buckets. Call ONLY on a failed attempt. */
export function recordLoginFailure(email: string, ip: string): void {
  const store = getStore();
  const now = Date.now();

  const keys = [emailKey(email)];
  if (ip && ip !== "unknown") keys.push(ipKey(ip));

  for (const key of keys) {
    const bucket = store.get(key);
    if (!bucket || bucket.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    } else {
      bucket.count += 1;
      store.set(key, bucket);
    }
  }
}

/**
 * Clear the email bucket after a correct password, so two typos followed by a
 * success leave no trace.
 *
 * The IP bucket is deliberately NOT cleared: an attacker who holds one valid
 * account on a shared address could otherwise reset the spray counter between
 * every batch of guesses. It ages out on its own within the window.
 */
export function clearLoginFailures(email: string): void {
  getStore().delete(emailKey(email));
}

/** Test seam — drops all counters. */
export function __resetLoginThrottleForTests(): void {
  getStore().clear();
}
