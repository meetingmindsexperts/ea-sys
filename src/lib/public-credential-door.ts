/**
 * The throttle + audit wrapper that EVERY public credential door must use.
 *
 * WHAT A "PUBLIC CREDENTIAL DOOR" IS
 * ----------------------------------
 * A route on the unauthenticated surface that checks a password. There are two
 * today — the group-registration coordinator sign-in and the abstract/proposal
 * "start as an existing user" step. Neither is a login *page*, but both compare
 * a password against `User.passwordHash`, which makes both brute-forceable and
 * both a real authentication event.
 *
 * THE GAP THIS CLOSES (group review M7)
 * -------------------------------------
 * Before this, those two doors had only the generic `checkRateLimit`, which
 *   (a) charges SUCCESSES, so it cannot be tightened to a credential-guessing
 *       ceiling without locking out a venue behind one NAT address, and
 *   (b) writes no `LoginEvent`, so a password-spray against them was invisible
 *       in Sign-in Activity — the one screen an admin opens to answer "is an
 *       account under attack?".
 * The dashboard/event login (NextAuth `authorize()`) has had both since July 28;
 * these doors were simply never wired up.
 *
 * WHY THE COMPARE LIVES IN HERE
 * -----------------------------
 * `isLoginBlocked` is only worth anything if it runs BEFORE bcrypt — bcrypt is
 * deliberately expensive, so a flood that reaches it costs us real CPU. Taking
 * the password and doing the compare ourselves makes that ordering structural
 * instead of a rule each caller has to remember.
 *
 * THE GENERIC LIMITER STAYS
 * -------------------------
 * Callers keep their existing `checkRateLimit` buckets. They do a different
 * job: bounding TOTAL requests to the endpoint (successes included) so the
 * route can't be used as a firehose. This guard bounds FAILED credential
 * attempts. Removing either to "simplify" would quietly loosen a live control.
 *
 * SURFACE
 * -------
 * Both doors record as `EVENT_PAGE`: they are sign-ins that happen on a public
 * `/e/[slug]/…` page, which is exactly what that value means. A dedicated
 * `PUBLIC_FORM` value would sharpen the story an admin reads but needs an enum
 * migration for a display distinction — the email, IP and outcome already carry
 * the signal that matters for detection.
 *
 * FORWARD-LOOKING TENANCY NOTE
 * ----------------------------
 * Both current callers run inside `runWithTenant(event.organizationId, …)`, so
 * the `LoginEvent` row is written with a tenant store SET while its own
 * `organizationId` is whatever the ACCOUNT has — null for the org-independent
 * roles (registrants, submitters, reviewers) that use these public doors.
 *
 * That is fine today: `LoginEvent` has no RLS policy, and `RLS_SET_LOCAL` is
 * off on master. It will NOT be fine the day LoginEvent is swept — a strict
 * `USING` rejects `create()`'s INSERT..RETURNING for an org-null row on a
 * tenant lane (the Domain-#18/#19 lesson, see prisma/rls/helpchatquery.sql).
 * Whoever sweeps LoginEvent must handle org-null rows the same way HelpChatQuery
 * does (`createMany`, or write them outside the tenant scope). Tracked in
 * ROADMAP so it isn't rediscovered by a fail-closed login audit.
 *
 * NOT YET SHARED WITH `authorize()`
 * ---------------------------------
 * NextAuth's `authorize()` in src/lib/auth.ts implements this same sequence
 * inline. It is deliberately NOT refactored onto this helper in the same change
 * as a security fix — it is the live login path for every staff account, and its
 * variant is interleaved with org attribution, a distinct `RateLimitedSignin`
 * throw and per-branch log lines. Adopting this helper there is tracked in
 * ROADMAP; the shape here is a superset so it can.
 */

import bcrypt from "bcryptjs";
import type { LoginSurface } from "@prisma/client";
import { isLoginBlocked, recordLoginFailure, clearLoginFailures } from "@/lib/login-throttle";
import { recordLoginEvent } from "@/lib/login-audit";
import { authLogger } from "@/lib/logger";

/** The minimum a caller's user row must carry for this guard to do its job. */
export interface CredentialUser {
  id: string;
  passwordHash: string | null;
  organizationId?: string | null;
}

export interface PublicCredentialInput<TUser extends CredentialUser> {
  /** Already lowercased by the caller (it also uses it for its own lookup). */
  email: string;
  password: string;
  /**
   * The account being checked, or null when the address matches none. Passing
   * the row in (rather than looking it up here) keeps each caller's own `select`
   * — they need different columns — and lets a blocked attempt on a REAL
   * account still be attributed to its org.
   */
  user: TUser | null;
  ipAddress: string | null;
  userAgent: string | null;
  surface: LoginSurface;
  /**
   * Whether a PASS is itself the authentication event worth recording.
   *
   * false when the client immediately calls NextAuth `signIn()` afterwards —
   * `authorize()` writes the SUCCESS row for that same human action, and a
   * second one here would double every successful sign-in in Sign-in Activity.
   * Failures are always recorded either way, because a client that gets a 401
   * here never proceeds to `signIn()`, so nothing else would ever see them.
   */
  recordSuccess: boolean;
  /** Route name for the log line, e.g. "public/group-register". */
  logLabel: string;
}

/**
 * On success the caller's own row comes back NON-NULL. That makes "a pass means
 * there is an account" a type-level fact rather than something each call site
 * re-asserts with `!` — the compiler enforces it and a future edit that returns
 * `ok` without a user won't build.
 */
export type PublicCredentialResult<TUser extends CredentialUser> =
  | { ok: true; user: TUser }
  | { ok: false; reason: "throttled"; retryAfterSeconds: number }
  | { ok: false; reason: "bad-credentials" };

/**
 * Throttle-check, verify the password, and record the attempt.
 *
 * Callers map the two failure shapes to their own responses — `throttled` to a
 * 429 with `Retry-After`, `bad-credentials` to whatever generic 401 message
 * that door already uses (this helper deliberately does not phrase user-facing
 * copy, because the two doors word it differently on purpose: one must avoid
 * revealing that the address exists, the other has already revealed it).
 *
 * Never throws on the audit path — `recordLoginEvent` swallows its own errors,
 * and the throttle store is in-memory.
 */
export async function verifyPublicCredentials<TUser extends CredentialUser>(
  input: PublicCredentialInput<TUser>,
): Promise<PublicCredentialResult<TUser>> {
  const { email, password, user, ipAddress, userAgent, surface, logLabel } = input;
  const ipForThrottle = ipAddress ?? "unknown";

  // Refuse before bcrypt so a flood costs us nothing.
  const throttle = isLoginBlocked(email, ipForThrottle);
  if (throttle.blocked) {
    authLogger.warn({
      msg: `${logLabel}:login-throttled`,
      ipAddress,
      reason: throttle.reason,
      retryAfterSeconds: throttle.retryAfterSeconds,
      userId: user?.id ?? null,
    });
    void recordLoginEvent({
      email,
      outcome: "BLOCKED_RATE_LIMIT",
      surface,
      userId: user?.id ?? null,
      organizationId: user?.organizationId ?? null,
      ipAddress,
      userAgent,
    });
    return { ok: false, reason: "throttled", retryAfterSeconds: throttle.retryAfterSeconds };
  }

  const verified =
    user && user.passwordHash && (await bcrypt.compare(password, user.passwordHash))
      ? user
      : null;

  if (!verified) {
    recordLoginFailure(email, ipForThrottle);
    // A known address with a bad password is a DIFFERENT signal from an address
    // matching nothing: the first means someone is being targeted, the second
    // is spray. Collapsing them would tell an admin nobody is under attack when
    // somebody is. (A known user with no hash counts as FAILED_PASSWORD — the
    // address is real.)
    void recordLoginEvent({
      email,
      outcome: user ? "FAILED_PASSWORD" : "FAILED_UNKNOWN_EMAIL",
      surface,
      userId: user?.id ?? null,
      organizationId: user?.organizationId ?? null,
      ipAddress,
      userAgent,
    });
    // No email in the log line — addresses live in LoginEvent, which is
    // SUPER_ADMIN/ADMIN-only; the broad log feed does not get PII.
    authLogger.warn({
      msg: `${logLabel}:bad-credentials`,
      ipAddress,
      knownAccount: !!user,
    });
    return { ok: false, reason: "bad-credentials" };
  }

  // Two typos then a success should leave no trace. Email bucket only — see
  // login-throttle.ts for why the IP bucket is deliberately not cleared.
  clearLoginFailures(email);
  if (input.recordSuccess) {
    void recordLoginEvent({
      email,
      outcome: "SUCCESS",
      surface,
      userId: verified.id,
      organizationId: verified.organizationId ?? null,
      ipAddress,
      userAgent,
    });
  }
  return { ok: true, user: verified };
}
