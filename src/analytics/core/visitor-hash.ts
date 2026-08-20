/**
 * Anonymous visitor identity.
 *
 * This file is the entire privacy argument for the analytics feature. If the
 * salt stops rotating we have quietly built a persistent cross-day identifier,
 * the data becomes personal data, and the claim made to clients in
 * docs/SECURITY_AND_PRIVACY_POSTURE.md stops being true. Nothing else in the
 * module carries that weight, which is why rotation has its own
 * mutation-verified test.
 *
 * SERVER ONLY. This imports node:crypto. Do not re-export it from a barrel
 * alongside the client-safe modules: Next would bundle node:crypto into the
 * browser build as undefined, and that failure is silent at build time and
 * shows up as a click that does nothing. That bug class has shipped here
 * before, which is why core/ deliberately has no index.ts.
 */

import { createHmac } from "node:crypto";

/** Default session window. Two hits inside it belong to one visit. */
export const DEFAULT_SESSION_WINDOW_MS = 30 * 60 * 1000;

/**
 * The salt window a moment falls in, as YYYY-MM-DD in UTC.
 *
 * UTC rather than the event's timezone on purpose. The window only has to be
 * consistent, and deriving it from event-local time would mean one visitor
 * hashing differently depending on which event page they happened to land on
 * first, which is both wrong and hard to reason about.
 */
export function saltWindowFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Derive the day's salt from a long-lived secret.
 *
 * Rotation is DERIVED, not scheduled. There is no cron to fail, no salt table
 * to migrate, and no state that can get stuck: the window is part of the input,
 * so tomorrow's salt is unavoidably different from today's. A scheduled
 * rotation would be a moving part that can silently stop, which is exactly the
 * failure this design refuses to have.
 *
 * The secret must be dedicated to analytics. Do not reuse an auth secret: one
 * value used for two unrelated purposes cannot be rotated for either without
 * breaking the other.
 */
export function deriveDailySalt(secret: string, window: string): string {
  if (!secret) {
    throw new Error(
      "analytics: salt secret is empty. Refusing to hash visitors with a known salt.",
    );
  }
  return createHmac("sha256", secret).update(window).digest("hex");
}

export interface VisitorHashInput {
  /** The day's derived salt, from deriveDailySalt(). */
  salt: string;
  /** Raw client IP. Consumed here and never stored anywhere. */
  ip: string;
  /** Raw user agent. Consumed here and never stored anywhere. */
  userAgent: string;
  /** Opaque tenant key, so one person on two tenants is two identities. */
  siteId: string;
}

/**
 * The anonymous visitor identifier.
 *
 * HMAC rather than a plain digest of concatenated fields: the salt is a key,
 * and keyed hashing is what HMAC is for. A bare sha256(salt + ip + ...) is also
 * vulnerable to length extension, which matters little here but costs nothing
 * to avoid.
 *
 * siteId is inside the hash so one person visiting two tenants produces two
 * unrelated identifiers. Without it a shared identifier would let two tenants
 * correlate a visitor between them, which is precisely the cross-site tracking
 * this design exists to make impossible.
 *
 * The field separator is a correctness guard, not decoration: without it,
 * ip "1.2.3" + ua "4x" and ip "1.2" + ua "34x" hash identically, which would
 * merge two people into one visitor.
 */
export function computeVisitorHash({ salt, ip, userAgent, siteId }: VisitorHashInput): string {
  return createHmac("sha256", salt)
    .update([siteId, ip, userAgent].join(" "))
    .digest("hex");
}

/**
 * The session identifier, derived rather than stored.
 *
 * There is no cookie, no localStorage and no sessionStorage anywhere in this
 * feature. That is stricter than strictly necessary and it is the property that
 * makes the ePrivacy consent question disappear rather than merely become
 * arguable.
 *
 * The cost is a boundary artifact: a visit straddling a window edge splits into
 * two sessions, which slightly over-counts. That is a known, accepted trade and
 * must NOT be "fixed" by introducing client-side storage.
 */
export function computeSessionHash(
  visitorHash: string,
  now: Date,
  windowMs: number = DEFAULT_SESSION_WINDOW_MS,
): string {
  if (windowMs <= 0) {
    throw new Error("analytics: session window must be positive");
  }
  const bucket = Math.floor(now.getTime() / windowMs);
  return createHmac("sha256", visitorHash).update(String(bucket)).digest("hex");
}

/**
 * Derive salt, visitor and session together, so a caller cannot accidentally
 * pair today's visitor hash with yesterday's salt.
 */
export function identifyVisitor(input: {
  secret: string;
  ip: string;
  userAgent: string;
  siteId: string;
  now: Date;
  sessionWindowMs?: number;
}): { visitorHash: string; sessionHash: string; saltWindow: string } {
  const saltWindow = saltWindowFor(input.now);
  const salt = deriveDailySalt(input.secret, saltWindow);
  const visitorHash = computeVisitorHash({
    salt,
    ip: input.ip,
    userAgent: input.userAgent,
    siteId: input.siteId,
  });
  const sessionHash = computeSessionHash(visitorHash, input.now, input.sessionWindowMs);
  return { visitorHash, sessionHash, saltWindow };
}
