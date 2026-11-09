import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { loadRegistrantScope } from "@/lib/registrant-access";
import { personalDetailsFields } from "@/lib/schemas";
import {
  changedFields,
  copyToUpcomingRegistrations,
  normalizeDetails,
  readAccountDetails,
  saveAccountProfile,
} from "@/lib/registrant-details";

/**
 * GET/PUT /api/registrant/account-details: My Details on /my-account/details
 * (Nov 9, 2026, docs/ACCOUNT_SIGNUP_PLAN.md).
 *
 * The person's own account details and marketing consent. A save stores them
 * on the account (AccountProfile, plus the name on User) and copies the fields
 * it CHANGED onto the person's upcoming registrations (owner, Nov 9, 2026),
 * with the rules in copyToUpcomingRegistrations: linked registrations only,
 * not started, not checked in, never a shared Attendee, never a speaker.
 *
 * The email address is not editable here: it has its own confirmed flow.
 * Every signed-in role may use it; it only ever reads and writes the caller's
 * own rows (userId from the session, re-read from the database).
 */

const ROUTE = "registrant/account-details";

const putSchema = z
  .object({
    ...personalDetailsFields,
    /** Absent: consent left as it is. */
    marketingConsent: z.boolean().optional(),
  })
  // The form's rule, checked here too: "Others" needs the specialty written in.
  .refine((d) => d.specialty !== "Others" || (d.customSpecialty?.trim().length ?? 0) > 0, {
    message: "Please enter your specialty",
    path: ["customSpecialty"],
  });

/** How many upcoming registrations a save would update, for the page to say so. */
async function upcomingCount(userId: string): Promise<number> {
  return db.registration.count({
    where: { userId, status: { in: ["PENDING", "CONFIRMED", "WAITLISTED"] }, event: { startDate: { gt: new Date() } } },
  });
}

export async function GET(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      apiLogger.warn({ msg: "account-details:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: ROUTE, userId }, async () => {
      const scope = await loadRegistrantScope(userId, { sessionTokenVersion: session?.user?.tokenVersion });
      if (!scope) {
        apiLogger.warn({ msg: "account-details:user-not-found", userId });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const [account, upcoming] = await Promise.all([readAccountDetails(scope), upcomingCount(userId)]);
      return NextResponse.json({ email: scope.email, ...account, upcomingRegistrations: upcoming });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "account-details:get-failed" });
    return NextResponse.json({ error: "Could not load your details" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  let userId: string | undefined;
  try {
    const session = await auth();
    userId = session?.user?.id;
    if (!userId) {
      apiLogger.warn({ msg: "account-details:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const owner = userId;

    const rl = checkRateLimit({ key: `account-details:${owner}`, limit: 30, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "account-details:rate-limited", userId: owner, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many saves. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds, limit: 30, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      apiLogger.warn({ msg: "account-details:validation-failed", userId: owner, fields: Object.keys(fieldErrors) });
      return NextResponse.json({ error: "Please check the highlighted fields.", fieldErrors }, { status: 400 });
    }

    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: ROUTE, userId: owner }, async () => {
      const scope = await loadRegistrantScope(owner, { sessionTokenVersion: session?.user?.tokenVersion });
      if (!scope) {
        apiLogger.warn({ msg: "account-details:user-not-found", userId: owner });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      // What the page showed: the delta is taken against it, so only what the
      // person actually changed reaches their registrations.
      const before = await readAccountDetails(scope);
      const after = normalizeDetails(parsed.data);
      const changed = changedFields(before.details, after);

      await saveAccountProfile(owner, after, parsed.data.marketingConsent, getClientIp(req));
      const copied = await copyToUpcomingRegistrations(owner, changed, after, new Date());

      apiLogger.info({
        msg: "account-details:saved",
        userId: owner,
        changed,
        marketingConsent: parsed.data.marketingConsent,
        registrationsUpdated: copied.updated,
        registrationsSkipped: copied.skipped,
        registrationsFailed: copied.failed,
      });
      return NextResponse.json({ ok: true, changed, registrations: copied });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "account-details:put-failed", userId });
    return NextResponse.json({ error: "Could not save your details. Please try again." }, { status: 500 });
  }
}
