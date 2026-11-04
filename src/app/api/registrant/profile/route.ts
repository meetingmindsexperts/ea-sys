import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

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
 * `{ profile: null }` when the person has no registration yet (a submitter, a
 * new account).
 */
export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) {
      apiLogger.warn({ msg: "registrant-profile:unauthorized" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const userEmail = session.user.email.toLowerCase();

    // Same lane as /api/registrant/registrations: a registrant is org-null, so
    // the tenant comes from the host, as sign-in does.
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: "registrant/profile", userId }, async () => {
      const latest = await db.registration.findFirst({
        // The same two ways the portal finds a person's registrations.
        where: { OR: [{ userId }, { attendee: { email: userEmail } }] },
        orderBy: { createdAt: "desc" },
        select: { attendee: { select: PROFILE_SELECT } },
      });
      return NextResponse.json({ profile: latest?.attendee ?? null });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "registrant-profile:failed" });
    return NextResponse.json({ error: "Failed to load your details" }, { status: 500 });
  }
}
