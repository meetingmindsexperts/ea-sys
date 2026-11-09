import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { loadRegistrantScope, ownRegistrationWhere } from "@/lib/registrant-access";
import { readAccountDetails } from "@/lib/registrant-details";

/**
 * The personal details a signed-in person gave on their latest registration,
 * so a registration form for another event can start filled in.
 *
 * Deliberately NOT here: billing (another event may have another payer),
 * member and student IDs and the supporting document (they belong to a
 * registration type, and an ID can expire), the additional email, and
 * anything about money or the registration itself.
 */
const PROFILE_SELECT = {
  title: true,
  role: true,
  firstName: true,
  lastName: true,
  organization: true,
  jobTitle: true,
  phone: true,
  city: true,
  state: true,
  zipCode: true,
  country: true,
  specialty: true,
  customSpecialty: true,
  dietaryReqs: true,
} as const;

/**
 * GET /api/registrant/profile
 * `{ profile: null }` when the person has neither account details nor a
 * registration yet.
 */
export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) {
      apiLogger.warn({ msg: "registrant-profile:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // Same lane as /api/registrant/registrations: a registrant is org-null, so
    // the tenant comes from the host, as sign-in does.
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: "registrant/profile", userId }, async () => {
      const scope = await loadRegistrantScope(userId, { sessionTokenVersion: session.user.tokenVersion });
      if (!scope) {
        apiLogger.warn({ msg: "registrant-profile:user-not-found", userId });
        return NextResponse.json({ profile: null });
      }
      const [latest, account] = await Promise.all([
        db.registration.findFirst({
          // The same rule as My events (registrant-access.ts): a registration
          // matched only by address pre-fills nothing until it is confirmed.
          where: ownRegistrationWhere(scope),
          orderBy: { createdAt: "desc" },
          select: { attendee: { select: PROFILE_SELECT } },
        }),
        readAccountDetails(scope),
      ]);
      // The account's own details win when it has them (given at sign-up or on
      // My Details, Nov 9, 2026): they are the person's latest word. The
      // latest registration still supplies what an account does not hold
      // (dietary requirements).
      if (account.source === "account") {
        return NextResponse.json({ profile: { ...(latest?.attendee ?? {}), ...account.details } });
      }
      return NextResponse.json({ profile: latest?.attendee ?? null });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registrant-profile:failed" });
    return NextResponse.json({ error: "Failed to load your details" }, { status: 500 });
  }
}
