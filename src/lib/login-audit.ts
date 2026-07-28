/**
 * The ONE writer of `LoginEvent`.
 *
 * There are four ways into this product — the dashboard login, the
 * event-scoped login, the auto-sign-in after abstract registration (all three
 * land in NextAuth's `authorize()`), and the separate bcrypt path in
 * `/api/auth/mobile-login`. Per the project's no-cross-caller-duplication rule
 * they all funnel through this function rather than each assembling their own
 * row; four copies of "what counts as a login" is exactly how the recorded
 * shape drifts apart.
 *
 * CONTRACT: never throws, never blocks.
 * Recording a sign-in must not be able to prevent one. Every failure is caught
 * and logged, so the worst a database blip can do is lose a row — it can never
 * lock a user out of the product. Callers may fire this without awaiting.
 */

import { db } from "@/lib/db";
import { authLogger } from "@/lib/logger";
import type { LoginOutcome, LoginSurface } from "@prisma/client";

/** Guard against an attacker using the email column as free storage. */
const MAX_EMAIL_LENGTH = 320;
const MAX_USER_AGENT_LENGTH = 1000;

export interface RecordLoginEventInput {
  email: string;
  outcome: LoginOutcome;
  surface: LoginSurface;
  /** Null for a failed attempt on an address that matches no account. */
  userId?: string | null;
  /** Null for org-independent users (reviewers, submitters, registrants). */
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Record one sign-in attempt.
 *
 * Email is normalized to lowercase so `Admin@x.com` and `admin@x.com` are one
 * subject when reading the history back — the same normalization the login
 * lookup itself does, which is what makes the two agree.
 */
export async function recordLoginEvent(input: RecordLoginEventInput): Promise<void> {
  try {
    const email = input.email.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);

    await db.loginEvent.create({
      data: {
        email,
        outcome: input.outcome,
        surface: input.surface,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      },
    });
  } catch (err) {
    // Deliberately swallowed — see the contract above. Logged at error because
    // losing the security trail is a real problem even though it must not be a
    // user-facing one.
    authLogger.error({
      err,
      msg: "login-audit:write-failed",
      outcome: input.outcome,
      surface: input.surface,
      userId: input.userId ?? null,
    });
  }
}

/**
 * Pull the user-agent off a request, tolerating its absence.
 *
 * Split out so the NextAuth path and the mobile route read the same header the
 * same way — the request object differs between them, the intent doesn't.
 */
export function readUserAgent(req: Request | undefined | null): string | null {
  try {
    return req?.headers?.get("user-agent") ?? null;
  } catch {
    return null;
  }
}
